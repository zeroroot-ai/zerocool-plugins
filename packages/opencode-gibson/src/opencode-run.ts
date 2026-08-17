import { spawn } from "node:child_process"

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
  /** opencode's session id — pass it back as `sessionId` to continue this session. */
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
  /** `provider/model`, e.g. `gibson/default`. Omitted lets opencode choose. */
  model?: string
  /** Continue an earlier opencode session instead of starting a new one. */
  sessionId?: string
  /** Hard deadline. The child is killed when it elapses. */
  timeoutMs?: number
  /** Extra environment for the child, merged over the parent's. */
  env?: NodeJS.ProcessEnv
  /** Binary to run. Overridable for tests and for a pinned install. */
  bin?: string
}

/** Build the argv for a headless run. Exported so a test can assert it. */
export function opencodeArgs(opts: OpencodeRunOptions): string[] {
  const args = ["run", "--format", "json", "--dir", opts.dir]
  // Unattended by definition: there is no human to answer a permission prompt,
  // and a run that blocks on one burns its whole timeout and then fails.
  args.push("--auto")
  if (opts.model) args.push("--model", opts.model)
  if (opts.sessionId) args.push("--session", opts.sessionId)
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
  const bin = opts.bin ?? process.env.ZEROCOOL_OPENCODE_BIN ?? "opencode"
  const args = opencodeArgs(opts)

  return await new Promise<OpencodeRunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.dir,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.timeoutMs && opts.timeoutMs > 0 ? { timeout: opts.timeoutMs, killSignal: "SIGTERM" as const } : {}),
    })

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))

    child.on("error", (e) => reject(new Error(`could not run ${bin}: ${e.message}`)))
    child.on("close", (code, signal) => {
      if (signal) {
        // Killed by the timeout. Say so with the deadline, because "terminated"
        // alone sends whoever reads the mission looking for a crash.
        reject(new Error(`opencode timed out after ${opts.timeoutMs}ms (killed with ${signal})`))
        return
      }
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("; ")
        reject(new Error(`opencode exited ${code}${tail ? `: ${tail}` : ""}`))
        return
      }
      resolve(parseOpencodeEvents(stdout))
    })
  })
}
