// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Drive opencode headless — the external driver half of the `kind=agent`
 * dispatched shape (zerocool-plugins#33, owner decision 2026-08-15: Option B).
 *
 * `opencode run --format json` emits NDJSON on stdout, one event per line. The
 * shape below is not inferred from docs; it is what opencode 1.18.13 actually
 * printed:
 *
 *   {"type":"step_start","timestamp":…,"sessionID":"ses_…","part":{…}}
 *   {"type":"text","timestamp":…,"sessionID":"ses_…","part":{"type":"text","text":"Hi there!…"}}
 *   {"type":"step_finish","timestamp":…,"sessionID":"ses_…",
 *    "part":{"reason":"stop","tokens":{"total":9787,"input":8740,"output":23,…},"cost":0}}
 *
 * Parsing is split from spawning on purpose: {@link parseOpencodeEvents} is pure
 * and is tested against those exact bytes, so a change in opencode's output
 * fails a unit test instead of a dispatched mission.
 *
 * The parser is deliberately tolerant. A line that is not JSON, or an event type
 * this version does not know, is skipped rather than fatal — opencode is free to
 * add event types, and a mission node must not fail because it did.
 */

/** Token accounting for one run, as reported by `step_finish`. */
export interface OpencodeTokens {
  total: number
  input: number
  output: number
  reasoning: number
}

/** What one headless opencode run produced. */
export interface OpencodeRunResult {
  /** opencode's session id. A run is one session, and the per-task home goes when it ends. */
  sessionId: string
  /** Every `text` part, concatenated in order. The agent's answer. */
  text: string
  /** `step_finish.reason`, e.g. "stop". Empty when the run produced no finish event. */
  finishReason: string
  tokens: OpencodeTokens
  cost: number
  /** How many NDJSON events parsed. Useful to tell "no output" from "not JSON". */
  events: number
}

interface OpencodeEvent {
  type?: string
  sessionID?: string
  part?: {
    type?: string
    text?: string
    reason?: string
    cost?: number
    tokens?: { total?: number; input?: number; output?: number; reasoning?: number }
  }
}

/** Parse the NDJSON `opencode run --format json` writes to stdout. */
export function parseOpencodeEvents(stdout: string): OpencodeRunResult {
  const result: OpencodeRunResult = {
    sessionId: "",
    text: "",
    finishReason: "",
    tokens: { total: 0, input: 0, output: 0, reasoning: 0 },
    cost: 0,
    events: 0,
  }
  const chunks: string[] = []

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: OpencodeEvent
    try {
      event = JSON.parse(trimmed) as OpencodeEvent
    } catch {
      continue // not an event line (a stray log, a partial write) — not fatal
    }
    result.events += 1
    if (event.sessionID) result.sessionId = event.sessionID

    if (event.type === "text" && typeof event.part?.text === "string") {
      chunks.push(event.part.text)
    } else if (event.type === "step_finish") {
      if (event.part?.reason) result.finishReason = event.part.reason
      if (typeof event.part?.cost === "number") result.cost += event.part.cost
      const t = event.part?.tokens
      if (t) {
        // Summed, not replaced: a multi-step run emits one step_finish per step
        // and the mission's cost is all of them, not the last one.
        result.tokens.total += t.total ?? 0
        result.tokens.input += t.input ?? 0
        result.tokens.output += t.output ?? 0
        result.tokens.reasoning += t.reasoning ?? 0
      }
    }
  }

  result.text = chunks.join("")
  return result
}

export interface OpencodeRunOptions {
  /** The natural-language objective — the mission node's Task.goal. */
  goal: string
  /** Working directory. opencode edits files here, so it is the run's workspace. */
  dir: string
  /** `provider/model`, e.g. `gibson/primary`. Omitted lets opencode choose. */
  model?: string
  /** Hard deadline. The child gets SIGTERM when it elapses, and SIGKILL after `killGraceMs`. */
  timeoutMs?: number
  /** The time between SIGTERM and SIGKILL, in ms. Defaults to {@link KILL_GRACE_MS}. */
  killGraceMs?: number
  /** Extra environment for the child, merged over the allow-listed parent environment. */
  env?: NodeJS.ProcessEnv
  /** Binary to run. Overridable for tests and for a pinned install. */
  bin?: string
  /**
   * Called with each complete NDJSON line as opencode prints it, live, before
   * the run finishes. A dispatched sandbox forwards these to its own stdout so
   * the daemon can stream the run to the read-only console. The same bytes are
   * still buffered and parsed at close, so this is a tap, not a replacement —
   * a slow or throwing sink never changes what the run returns.
   */
  onEvent?: (line: string) => void
}

/**
 * Split a byte stream into complete lines across chunk boundaries.
 *
 * `spawn`'s `data` events do not align to newlines: one event can carry half a
 * line, or several lines and a fragment. This buffers the fragment and calls
 * `onLine` once per complete, non-empty line, so a live tap sees whole NDJSON
 * events and never half of one. `flush` emits a trailing line with no final
 * newline. Exported so the boundary handling is tested directly.
 */
export function createLineStreamer(onLine: (line: string) => void): {
  push: (chunk: string) => void
  flush: () => void
} {
  let pending = ""
  const emit = (raw: string): void => {
    const line = raw.trim()
    if (line) onLine(line)
  }
  return {
    push(chunk: string): void {
      pending += chunk
      let nl: number
      while ((nl = pending.indexOf("\n")) >= 0) {
        emit(pending.slice(0, nl))
        pending = pending.slice(nl + 1)
      }
    },
    flush(): void {
      const rest = pending
      pending = ""
      emit(rest)
    },
  }
}

/**
 * Environment names and prefixes the opencode child may see. Everything else
 * is dropped, so the launcher's component grant (`GIBSON_CG_JWT`), the
 * one-time enrollment token (`GIBSON_BOOTSTRAP_TOKEN`) and the launch task
 * (`GIBSON_AGENT_TASK_B64`) never reach a process that runs with `--auto`
 * and has a shell. `knowledge-source.ts` states the child contract: it reads
 * `GIBSON_CALLBACK_ENDPOINT` and `GIBSON_CALLBACK_TOKEN`, which the caller
 * passes in `opts.env`, and nothing of the launch environment.
 *
 * A child that has the task grant gets no `GIBSON_HOST_KEY_PATH`, and its
 * `HOME` and `XDG_*` point at a per-task directory (see `opencodeChildEnv`).
 *
 * `GIBSON_` names are listed one by one and never by prefix: the grant and
 * the token share that prefix with the addressing the child plugin reads.
 * The provider credential passes through because opencode itself reads it
 * for a model that is not served through the Model gateway, the same posture
 * `claude-member/src/env.ts` takes for Claude Code. A dispatched run has the
 * gateway and nothing else, so it gets none of them (see
 * {@link DIRECT_PROVIDER_PREFIXES}).
 */
const CHILD_ENV_ALLOW_EXACT: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TZ",
  "TERM",
  "TMPDIR",
  "NO_PROXY",
  "no_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "CLOUD_ML_REGION",
  // Addressing the child plugin reads (index.ts, mcp-config.ts). No secret.
  "GIBSON_PLATFORM_URL",
  "GIBSON_DAEMON_URL",
  "GIBSON_HOST_KEY_PATH",
  "GIBSON_AGENT_MODE",
  "GIBSON_MODEL_SLOT",
  "GIBSON_TARGET_ID",
  "GIBSON_CA_CERT",
]

const CHILD_ENV_ALLOW_PREFIX: readonly string[] = [
  "LANG",
  "LC_",
  "XDG_",
  "NODE_",
  "SSL_CERT_",
  "OPENCODE_",
  "ZEROCOOL_",
  "ANTHROPIC_",
  "OPENAI_",
  "AWS_",
  "GOOGLE_",
  "AZURE_",
]

/**
 * The names of a direct model provider credential or region. A child that has
 * the task grant reaches its model through the Model gateway. It gets none of
 * these, so a failed gateway path cannot end in a call on a direct key.
 */
const DIRECT_PROVIDER_EXACT: readonly string[] = ["CLOUD_ML_REGION", "OPENCODE_API_KEY"]
const DIRECT_PROVIDER_PREFIXES: readonly string[] = ["ANTHROPIC_", "OPENAI_", "AWS_", "GOOGLE_", "AZURE_"]

/**
 * The environment the opencode child gets: the allow list above from `parent`,
 * then `extra` on top. `extra` is the per-dispatch grant from
 * `dispatchChildEnv`, which is the only way a `GIBSON_CALLBACK_*` name reaches
 * the child. When `extra` carries the task grant, the direct provider
 * credentials of `parent` do not pass.
 */
export function opencodeChildEnv(parent: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}, home?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  const gatewayOnly = Boolean(extra.GIBSON_CALLBACK_TOKEN)
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue
    if (!CHILD_ENV_ALLOW_EXACT.includes(k) && !CHILD_ENV_ALLOW_PREFIX.some((p) => k.startsWith(p))) continue
    if (gatewayOnly && (DIRECT_PROVIDER_EXACT.includes(k) || DIRECT_PROVIDER_PREFIXES.some((p) => k.startsWith(p)))) continue
    // A granted child has no path to the home of the worker user. That home
    // holds the host key and the stored provider keys of opencode.
    if (gatewayOnly && (GRANTED_DROP_EXACT.includes(k) || k === "HOME" || k.startsWith("XDG_"))) continue
    out[k] = v
  }
  if (gatewayOnly && home) Object.assign(out, isolatedHomeEnv(home))
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) out[k] = v
  }
  // The driver registers the plugin in OPENCODE_CONFIG_CONTENT. An operator may
  // have set that variable too, so join the two instead of replacing one.
  if (extra.OPENCODE_CONFIG_CONTENT && out.OPENCODE_CONFIG_CONTENT !== undefined && parent.OPENCODE_CONFIG_CONTENT) {
    out.OPENCODE_CONFIG_CONTENT = mergeConfigContent(parent.OPENCODE_CONFIG_CONTENT, extra.OPENCODE_CONFIG_CONTENT)
  }
  return out
}

/**
 * Join two `OPENCODE_CONFIG_CONTENT` values. The keys of `ours` win, and the
 * `plugin` lists join with no duplicate. A value of the operator that is not
 * a JSON object throws: opencode refuses it too, and a run must not continue
 * with a config that the operator wrote and that nothing applies.
 */
export function mergeConfigContent(operator: string, ours: string): string {
  let base: unknown
  try {
    base = JSON.parse(operator)
  } catch {
    // A fixed text. The message of JSON.parse quotes part of the input, and the
    // input can hold a provider key. This error goes to the mission record.
    throw new Error("OPENCODE_CONFIG_CONTENT is not valid JSON")
  }
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object")
  }
  const operatorConfig = base as Record<string, unknown>
  const mine = JSON.parse(ours) as Record<string, unknown>
  const plugins = [...asList(operatorConfig.plugin), ...asList(mine.plugin)]
  return JSON.stringify({ ...operatorConfig, ...mine, plugin: [...new Set(plugins)] })
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Names that a granted child never gets. The host key is the long-lived identity of the worker host. */
const GRANTED_DROP_EXACT: readonly string[] = ["GIBSON_HOST_KEY_PATH"]

/** `HOME` and the XDG directories of a granted child, all inside one per-task directory. */
function isolatedHomeEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
  }
}

/** Build the argv for a headless run. Exported so a test can assert it. */
export function opencodeArgs(opts: OpencodeRunOptions): string[] {
  const args = ["run", "--format", "json", "--dir", opts.dir]
  // Unattended by definition: there is no human to answer a permission prompt,
  // and a run that blocks on one burns its whole timeout and then fails.
  args.push("--auto")
  if (opts.model) args.push("--model", opts.model)
  // The goal goes last: `message..` is a variadic positional, so anything after
  // it would be swallowed as more message.
  args.push(opts.goal)
  return args
}

/**
 * Run opencode headless once and return what it produced.
 *
 * Throws on a non-zero exit or a timeout. The caller is
 * {@link ../serve-agent.ts}'s handler, and `startAgentWorker` turns a throw into
 * an in-band `ExecuteResponse.error` — so a crashed run fails its mission node
 * with a reason instead of stalling it until the dispatch times out.
 */
export async function runOpencode(opts: OpencodeRunOptions): Promise<OpencodeRunResult> {
  // A run with a task grant gets a fresh home and fresh XDG directories, so the
  // stored keys and the config of the worker user are not there for a shell
  // command of the model to read. The directory is removed when the run ends.
  const home = opts.env?.GIBSON_CALLBACK_TOKEN ? await mkdtemp(join(await runBaseDir(), "run-")) : undefined
  try {
    return await spawnOpencode(opts, home)
  } finally {
    // A failed removal must not replace the result or the error of the run.
    // The next start of a worker removes what is left.
    if (home) {
      await rm(home, { recursive: true, force: true }).catch((e: unknown) =>
        console.error(`[zerocool] could not remove the run directory ${home}: ${(e as Error).message}`),
      )
    }
  }
}

/**
 * The run directories of one worker start live under one base directory that
 * only this start uses. Its name holds the uid and a random id of this start
 * (`zerocool-runs-<uid>-<id>`), and its mode is 0700. A pid is no key for this:
 * it is valid only in the PID namespace of the worker, and a container restart
 * gives pid 1 again. The worker touches `.alive` in its base each minute, and a
 * base that nobody touched for a grant life belongs to no live worker.
 */
const BOOT_ID = randomBytes(8).toString("hex")
const BASE_NAME = /^zerocool-runs-(\d+)-([0-9a-f]{16})$/
const ALIVE_FILE = ".alive"
const HEARTBEAT_MS = 60_000

/** The longest life of one task grant (gibson `capabilitygrant.MaxLifetime`). A base that nobody touched for longer belongs to no live grant. */
export const MAX_GRANT_LIFE_MS = 30 * 60 * 1000

/** The time between SIGTERM and SIGKILL of a child that passed its deadline. */
export const KILL_GRACE_MS = 5_000

let runBase: Promise<string> | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined

const ownBasePath = (): string => join(tmpdir(), `zerocool-runs-${process.getuid?.() ?? 0}-${BOOT_ID}`)

/**
 * The base directory of this worker start. It is made on first use, with mode
 * 0700. A failure after the `mkdir` removes the base again, so it cannot block
 * the next run with EEXIST.
 *
 * Limit: the age of a base is the wall clock minus the mtime of `.alive`. A
 * clock that jumps forward by more than a grant life can make a live base look
 * stale. The scan runs only at worker start, and the heartbeat refreshes the
 * file each minute, so the window is small. No monotonic clock can compare
 * with an mtime of another process.
 */
export function runBaseDir(): Promise<string> {
  runBase ??= (async () => {
    const base = ownBasePath()
    let created = false
    try {
      await mkdir(base, { mode: 0o700 })
      created = true
      await chmod(base, 0o700)
      const alive = join(base, ALIVE_FILE)
      await writeFile(alive, "")
      heartbeat = setInterval(() => void utimes(alive, new Date(), new Date()).catch(() => {}), HEARTBEAT_MS)
      heartbeat.unref()
      return base
    } catch (e) {
      if (created) await rm(base, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  })().catch((e: unknown) => {
    runBase = undefined
    throw e
  })
  return runBase
}

/**
 * Stop the heartbeat and remove the base of this worker start, with every run
 * directory in it. Call it after {@link stopAllRuns}. A later run makes a new base.
 */
export async function stopRunBase(): Promise<void> {
  const pending = runBase
  runBase = undefined
  clearInterval(heartbeat)
  heartbeat = undefined
  await pending?.catch(() => {})
  await rm(ownBasePath(), { recursive: true, force: true }).catch((e: unknown) =>
    console.error(`[zerocool] could not remove the run base directory: ${(e as Error).message}`),
  )
}

/** The pids of the process groups of the runs that are live now. */
const liveGroups = new Set<number>()

/** Send a signal to a process group. ESRCH, no process left, is not an error. Any other error is logged. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
      console.error(`[zerocool] could not send ${signal} to process group ${pid}: ${(e as Error).message}`)
    }
  }
}

/**
 * End every live run. The worker calls it when it stops. A run is detached in
 * its own process group, so Ctrl-C of the worker does not reach it. Each group
 * gets SIGTERM, then SIGKILL after the grace period, and the run directories
 * go. The runs then end with `opencode was killed by <signal>`.
 */
export async function stopAllRuns(graceMs: number = KILL_GRACE_MS): Promise<void> {
  for (const pid of liveGroups) signalGroup(pid, "SIGTERM")
  const until = Date.now() + graceMs
  while (liveGroups.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25))
  for (const pid of liveGroups) signalGroup(pid, "SIGKILL")
  await stopRunBase()
}

/**
 * Remove the base directories that an earlier worker start left behind. A base
 * goes when it is a real directory (no symbolic link), the user of this process
 * owns it, it is not the base of this start, and nothing touched it for longer
 * than a grant life. It returns the names it removed.
 */
export async function removeStaleRunDirs(
  opts: { root?: string; now?: number; bootId?: string } = {},
): Promise<string[]> {
  const root = opts.root ?? tmpdir()
  const now = opts.now ?? Date.now()
  const bootId = opts.bootId ?? BOOT_ID
  const uid = process.getuid?.()
  const removed: string[] = []
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const match = BASE_NAME.exec(name)
    if (!match || match[2] === bootId) continue
    if (uid !== undefined && Number(match[1]) !== uid) continue
    const path = join(root, name)
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isDirectory() || (uid !== undefined && info.uid !== uid)) continue
    const alive = await lstat(join(path, ALIVE_FILE)).catch(() => undefined)
    const lastTouch = alive?.isFile() ? alive.mtimeMs : info.mtimeMs
    if (now - lastTouch <= MAX_GRANT_LIFE_MS) continue
    await rm(path, { recursive: true, force: true }).then(
      () => void removed.push(name),
      (e: unknown) => console.error(`[zerocool] could not remove the stale run directory ${path}: ${(e as Error).message}`),
    )
  }
  return removed
}

async function spawnOpencode(opts: OpencodeRunOptions, home: string | undefined): Promise<OpencodeRunResult> {
  const bin = opts.bin ?? process.env.ZEROCOOL_OPENCODE_BIN ?? "opencode"
  const args = opencodeArgs(opts)

  return await new Promise<OpencodeRunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.dir,
      env: opencodeChildEnv(process.env, opts.env, home),
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so one signal reaches opencode and every
      // process that stays in the group. A background shell command of the
      // model must not outlive the run with the task grant in its environment.
      // A process that starts a new session (setsid) or a new group leaves the
      // group, and this does not reach it.
      detached: true,
    })

    // The group is signaled until opencode exits, and never after. After the
    // group is gone its id could belong to another process.
    let groupDone = false
    if (child.pid !== undefined) liveGroups.add(child.pid)
    const killGroup = (signal: NodeJS.Signals): void => {
      if (groupDone) return
      if (child.pid !== undefined) signalGroup(child.pid, signal)
      else child.kill(signal)
    }

    let stdout = ""
    let stderr = ""
    // A live tap for the daemon console, only when the caller asked for one. The
    // streamer is guarded so a throwing sink cannot fail the run — the buffered
    // parse below is the source of truth for the result.
    const streamer = opts.onEvent
      ? createLineStreamer((line) => {
          try {
            opts.onEvent?.(line)
          } catch {
            // A broken console tap must not cost a mission its result.
          }
        })
      : undefined
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString()
      stdout += s
      streamer?.push(s)
    })
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))

    // The deadline. SIGTERM first. A child that ignores it gets SIGKILL after a
    // grace period, and the run then ends at once even when a grandchild still
    // holds the pipes open, so the promise cannot hang and the directory goes.
    let settled = false
    let timedOut = false
    let termTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      fn()
    }
    const timedOutError = (signal: string): Error =>
      new Error(`opencode timed out after ${opts.timeoutMs}ms (killed with ${signal})`)
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      termTimer = setTimeout(() => {
        timedOut = true
        killGroup("SIGTERM")
        killTimer = setTimeout(() => {
          killGroup("SIGKILL")
          child.stdout.destroy()
          child.stderr.destroy()
          settle(() => reject(timedOutError("SIGKILL")))
        }, opts.killGraceMs ?? KILL_GRACE_MS)
      }, opts.timeoutMs)
    }

    child.on("error", (e) => settle(() => reject(new Error(`could not run ${bin}: ${e.message}`))))
    // opencode ended, however it ended. Kill what is left in its group. This
    // also closes the pipes that a background process holds, so `close` fires.
    child.on("exit", () => {
      killGroup("SIGKILL")
      groupDone = true
      if (child.pid !== undefined) liveGroups.delete(child.pid)
    })
    child.on("close", (code, signal) => {
      streamer?.flush()
      if (timedOut) {
        // Killed by the timeout. Say so with the deadline, because "terminated"
        // alone sends whoever reads the mission looking for a crash.
        settle(() => reject(timedOutError(signal ?? "SIGTERM")))
        return
      }
      if (signal) {
        settle(() => reject(new Error(`opencode was killed by ${signal}`)))
        return
      }
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("; ")
        settle(() => reject(new Error(`opencode exited ${code}${tail ? `: ${tail}` : ""}`)))
        return
      }
      settle(() => resolve(parseOpencodeEvents(stdout)))
    })
  })
}
