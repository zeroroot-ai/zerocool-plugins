// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  createLineStreamer,
  mergeConfigContent,
  opencodeArgs,
  opencodeChildEnv,
  parseOpencodeEvents,
  removeStaleRunDirs,
  runBaseDir,
  runOpencode,
} from "./opencode-run.js"

/**
 * The fixture below is REAL output, not a hand-written guess: it is what
 * `opencode run --format json --pure --dir . "say hi"` printed on opencode
 * 1.18.13. Hand-written fixtures are how a parser passes its own tests and
 * still fails against the tool it parses.
 */
const REAL_OUTPUT = [
  `{"type":"step_start","timestamp":1786987016649,"sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","part":{"id":"prt_010b9f1c6001paDxDDzq4VBUkd","messageID":"msg_010b9e473001iSke19fN799Qlo","sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","type":"step-start"}}`,
  `{"type":"text","timestamp":1786987017053,"sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","part":{"id":"prt_010b9f289001Uptk4cH3gToULB","messageID":"msg_010b9e473001iSke19fN799Qlo","sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","type":"text","text":"Hi there! 👋 How can I help you today?","time":{"start":1786987016841,"end":1786987017028}}}`,
  `{"type":"step_finish","timestamp":1786987017053,"sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","part":{"id":"prt_010b9f34b001k0BOWFDixPWMeb","reason":"stop","messageID":"msg_010b9e473001iSke19fN799Qlo","sessionID":"ses_fef461e36ffeDhqkkAtmFueEBd","type":"step-finish","tokens":{"total":9787,"input":8740,"output":23,"reasoning":0,"cache":{"write":0,"read":1024}},"cost":0}}`,
].join("\n")

test("parseOpencodeEvents reads a real run's text, session and accounting", () => {
  const run = parseOpencodeEvents(REAL_OUTPUT)
  assert.equal(run.text, "Hi there! 👋 How can I help you today?")
  assert.equal(run.sessionId, "ses_fef461e36ffeDhqkkAtmFueEBd")
  assert.equal(run.finishReason, "stop")
  assert.equal(run.tokens.total, 9787)
  assert.equal(run.tokens.output, 23)
  assert.equal(run.events, 3)
})

test("parseOpencodeEvents concatenates every text part in order", () => {
  const out = [
    `{"type":"text","sessionID":"s1","part":{"type":"text","text":"first "}}`,
    `{"type":"text","sessionID":"s1","part":{"type":"text","text":"second"}}`,
  ].join("\n")
  assert.equal(parseOpencodeEvents(out).text, "first second")
})

test("parseOpencodeEvents sums a multi-step run rather than keeping the last step", () => {
  // A real coding task is many steps. Reporting only the last step's tokens
  // would under-bill the mission by however many steps came before it.
  const out = [
    `{"type":"step_finish","sessionID":"s1","part":{"reason":"stop","tokens":{"total":100,"input":80,"output":20,"reasoning":0},"cost":0.5}}`,
    `{"type":"step_finish","sessionID":"s1","part":{"reason":"stop","tokens":{"total":300,"input":250,"output":50,"reasoning":0},"cost":1.25}}`,
  ].join("\n")
  const run = parseOpencodeEvents(out)
  assert.equal(run.tokens.total, 400)
  assert.equal(run.tokens.output, 70)
  assert.equal(run.cost, 1.75)
})

test("parseOpencodeEvents skips a non-JSON line instead of failing the run", () => {
  // A stray log line on stdout must not cost a mission node its result.
  const out = [
    `INFO  something opencode decided to print`,
    `{"type":"text","sessionID":"s1","part":{"type":"text","text":"kept"}}`,
  ].join("\n")
  const run = parseOpencodeEvents(out)
  assert.equal(run.text, "kept")
  assert.equal(run.events, 1)
})

test("parseOpencodeEvents ignores event types this version does not know", () => {
  const out = [
    `{"type":"tool","sessionID":"s1","part":{"type":"tool","name":"bash"}}`,
    `{"type":"text","sessionID":"s1","part":{"type":"text","text":"done"}}`,
  ].join("\n")
  const run = parseOpencodeEvents(out)
  assert.equal(run.text, "done")
  assert.equal(run.events, 2)
})

test("parseOpencodeEvents reports empty output distinguishably from unparsable output", () => {
  assert.equal(parseOpencodeEvents("").events, 0)
  assert.equal(parseOpencodeEvents("not json at all").events, 0)
  assert.equal(parseOpencodeEvents(`{"type":"step_start","sessionID":"s1"}`).events, 1)
})

test("the opencode child never sees the launcher's grant, enrollment token or task", () => {
  const child = opencodeChildEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/agent",
      LANG: "C.UTF-8",
      XDG_CONFIG_HOME: "/home/agent/.config",
      OPENCODE_CONFIG: "/etc/opencode.json",
      GIBSON_PLATFORM_URL: "https://api.example:30443",
      GIBSON_HOST_KEY_PATH: "/home/agent/.zerocool/host.key",
      GIBSON_CG_JWT: "component-grant",
      GIBSON_BOOTSTRAP_TOKEN: "one-time-enrollment",
      GIBSON_AGENT_TASK_B64: "e30=",
      GIBSON_TURN_TOKEN: "driver-secret",
      ZEROCOOL_OPENCODE_BIN: "/opt/opencode",
      ANTHROPIC_API_KEY: "sk-ant-operator",
      GITLAB_TOKEN: "glpat-secret",
      SOME_OTHER_SECRET: "nope",
    },
    { GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: "task-grant" },
  )
  assert.equal(child.GIBSON_CG_JWT, undefined, "the component grant stays in the launcher")
  assert.equal(child.GIBSON_BOOTSTRAP_TOKEN, undefined, "the enrollment token stays in the launcher")
  assert.equal(child.GIBSON_AGENT_TASK_B64, undefined, "the launch task is read once, by the launcher")
  assert.equal(child.GIBSON_TURN_TOKEN, undefined)
  assert.equal(child.GITLAB_TOKEN, undefined)
  assert.equal(child.SOME_OTHER_SECRET, undefined, "the allow list drops what it does not name")
  assert.equal(child.GIBSON_CALLBACK_ENDPOINT, "gibson:50001", "the child contract arrives through extra")
  assert.equal(child.GIBSON_CALLBACK_TOKEN, "task-grant")
  assert.equal(child.GIBSON_PLATFORM_URL, "https://api.example:30443", "addressing passes")
  assert.equal(child.GIBSON_HOST_KEY_PATH, undefined, "a granted child gets no host key")
  assert.equal(child.PATH, "/usr/bin")
  assert.equal(child.LANG, "C.UTF-8")
  assert.equal(child.XDG_CONFIG_HOME, undefined, "the config home of the worker user does not pass")
  assert.equal(child.OPENCODE_CONFIG, "/etc/opencode.json")
  assert.equal(child.ZEROCOOL_OPENCODE_BIN, "/opt/opencode")
  assert.equal(child.ANTHROPIC_API_KEY, undefined, "a dispatched child reaches its model through the gateway, not a direct key")
})

test("runOpencode spawns the child with the allow-listed environment, not the launcher's", async () => {
  const bin = fileURLToPath(new URL("../test/bin/fake-opencode-env.mjs", import.meta.url))
  const prev = { cg: process.env.GIBSON_CG_JWT, boot: process.env.GIBSON_BOOTSTRAP_TOKEN }
  process.env.GIBSON_CG_JWT = "component-grant"
  process.env.GIBSON_BOOTSTRAP_TOKEN = "one-time-enrollment"
  try {
    const run = await runOpencode({ goal: "print env", dir: process.cwd(), bin, env: { GIBSON_CALLBACK_TOKEN: "task-grant" } })
    const seen = JSON.parse(run.text) as Record<string, string | undefined>
    assert.equal(seen.GIBSON_CG_JWT, undefined)
    assert.equal(seen.GIBSON_BOOTSTRAP_TOKEN, undefined)
    assert.equal(seen.GIBSON_CALLBACK_TOKEN, "task-grant")
    assert.ok(seen.PATH, "the child can still find binaries")
  } finally {
    if (prev.cg === undefined) delete process.env.GIBSON_CG_JWT
    else process.env.GIBSON_CG_JWT = prev.cg
    if (prev.boot === undefined) delete process.env.GIBSON_BOOTSTRAP_TOKEN
    else process.env.GIBSON_BOOTSTRAP_TOKEN = prev.boot
  }
})

test("opencodeArgs runs unattended, in the workspace, as JSON", () => {
  const args = opencodeArgs({ goal: "fix the build", dir: "/srv/work" })
  assert.deepEqual(args, ["run", "--format", "json", "--dir", "/srv/work", "--auto", "fix the build"])
})

test("opencodeArgs puts the goal last so it cannot swallow a flag", () => {
  // `message..` is a variadic positional: anything after it is more message.
  const args = opencodeArgs({
    goal: "fix the build",
    dir: "/srv/work",
    model: "gibson/primary",
  })
  assert.equal(args[args.length - 1], "fix the build")
  assert.ok(args.includes("--model") && args.includes("gibson/primary"))
  assert.ok(!args.includes("--session"), "a run is one session")
})

test("opencodeArgs omits the model when unset", () => {
  const args = opencodeArgs({ goal: "g", dir: "." })
  assert.ok(!args.includes("--model"))
})

/**
 * The live tap. A sandboxed dispatch forwards each opencode event to its own
 * stdout as it arrives, so the daemon can stream the run. `spawn`'s data events
 * do not align to newlines, so the streamer must reassemble lines across chunk
 * boundaries — that is the whole failure it exists to prevent.
 */
test("createLineStreamer emits one whole line per newline", () => {
  const lines: string[] = []
  const s = createLineStreamer((l) => lines.push(l))
  s.push('{"a":1}\n{"b":2}\n')
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
})

test("createLineStreamer reassembles a line split across chunks", () => {
  // The failure case: opencode wrote one event but the OS delivered it in two
  // reads. A naive tap would emit two broken half-lines.
  const lines: string[] = []
  const s = createLineStreamer((l) => lines.push(l))
  s.push('{"type":"te')
  s.push('xt","text":"hi"}\n')
  assert.deepEqual(lines, ['{"type":"text","text":"hi"}'])
})

test("createLineStreamer holds a partial line until flush", () => {
  const lines: string[] = []
  const s = createLineStreamer((l) => lines.push(l))
  s.push('{"last":true}')
  assert.deepEqual(lines, [], "no newline yet, nothing emitted")
  s.flush()
  assert.deepEqual(lines, ['{"last":true}'], "flush emits the trailing line")
})

test("createLineStreamer skips blank lines and a bare flush", () => {
  const lines: string[] = []
  const s = createLineStreamer((l) => lines.push(l))
  s.push("\n\n")
  s.flush()
  assert.deepEqual(lines, [])
})

test("a run with the task grant gets no direct provider credential", () => {
  const parent = {
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sk-a",
    OPENAI_API_KEY: "sk-o",
    AWS_SECRET_ACCESS_KEY: "aws",
    GOOGLE_API_KEY: "g",
    AZURE_OPENAI_KEY: "az",
    CLOUD_ML_REGION: "us",
    ZEROCOOL_WORKSPACE: "/srv",
  }
  const child = opencodeChildEnv(parent, { GIBSON_CALLBACK_TOKEN: "grant", GIBSON_CALLBACK_ENDPOINT: "d:1" })
  assert.equal(child.PATH, "/bin")
  assert.equal(child.ZEROCOOL_WORKSPACE, "/srv")
  assert.equal(child.GIBSON_CALLBACK_TOKEN, "grant")
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GOOGLE_API_KEY", "AZURE_OPENAI_KEY", "CLOUD_ML_REGION"]) {
    assert.equal(child[name], undefined, `${name} must not reach a gateway-only child`)
  }
})

test("a run with no task grant keeps the provider credentials of the user", () => {
  const child = opencodeChildEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-a" }, {})
  assert.equal(child.ANTHROPIC_API_KEY, "sk-a")
})

test("a granted child gets a per-task home and no host key, and a child with no grant keeps both", () => {
  const parent = { PATH: "/bin", HOME: "/home/agent", XDG_DATA_HOME: "/home/agent/.local/share", GIBSON_HOST_KEY_PATH: "/home/agent/.zerocool/host.key" }
  const granted = opencodeChildEnv(parent, { GIBSON_CALLBACK_TOKEN: "g", GIBSON_CALLBACK_ENDPOINT: "d:1" }, "/tmp/run-1")
  assert.equal(granted.HOME, "/tmp/run-1")
  assert.equal(granted.XDG_CONFIG_HOME, "/tmp/run-1/config")
  assert.equal(granted.XDG_DATA_HOME, "/tmp/run-1/data")
  assert.equal(granted.XDG_CACHE_HOME, "/tmp/run-1/cache")
  assert.equal(granted.XDG_STATE_HOME, "/tmp/run-1/state")
  assert.equal(granted.GIBSON_HOST_KEY_PATH, undefined)
  const none = opencodeChildEnv(parent, {})
  assert.equal(none.HOME, "/home/agent")
  assert.equal(none.XDG_DATA_HOME, "/home/agent/.local/share")
  assert.equal(none.GIBSON_HOST_KEY_PATH, "/home/agent/.zerocool/host.key")
})

test("runOpencode runs a granted child in a fresh home that it removes, and never shows it the host key path", async () => {
  const bin = fileURLToPath(new URL("../test/bin/fake-opencode-env.mjs", import.meta.url))
  const prev = { home: process.env.HOME, key: process.env.GIBSON_HOST_KEY_PATH }
  process.env.HOME = "/home/worker"
  process.env.GIBSON_HOST_KEY_PATH = "/home/worker/.zerocool/host.key"
  try {
    const run = await runOpencode({ goal: "print env", dir: process.cwd(), bin, env: { GIBSON_CALLBACK_TOKEN: "task-grant" } })
    const seen = JSON.parse(run.text) as Record<string, string | undefined>
    assert.equal(seen.GIBSON_HOST_KEY_PATH, undefined)
    assert.ok(seen.HOME && seen.HOME !== "/home/worker", "a fresh home")
    for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
      assert.ok(seen[k]?.startsWith(`${seen.HOME}/`), `${k} is inside the fresh home`)
    }
    assert.equal(existsSync(seen.HOME), false, "the home is removed after the run")
    const ungranted = await runOpencode({ goal: "print env", dir: process.cwd(), bin })
    assert.equal((JSON.parse(ungranted.text) as Record<string, string>).HOME, "/home/worker")
  } finally {
    if (prev.home === undefined) delete process.env.HOME
    else process.env.HOME = prev.home
    if (prev.key === undefined) delete process.env.GIBSON_HOST_KEY_PATH
    else process.env.GIBSON_HOST_KEY_PATH = prev.key
  }
})

/** Write an executable node script and return its path. */
async function script(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-fake-"))
  const path = join(dir, "opencode")
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

test("a child that ignores SIGTERM gets SIGKILL after the grace period, and its home goes", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "zerocool-marker-")), "home")
  const bin = await script(`
    const fs = require("node:fs")
    fs.writeFileSync(${JSON.stringify(marker)}, process.env.HOME)
    process.on("SIGTERM", () => {})
    setInterval(() => {}, 1000)
  `)
  const started = Date.now()
  await assert.rejects(
    () => runOpencode({ goal: "g", dir: process.cwd(), bin, timeoutMs: 300, killGraceMs: 300, env: { GIBSON_CALLBACK_TOKEN: "g" } }),
    /opencode timed out after 300ms \(killed with SIG(KILL|TERM)\)/,
  )
  assert.ok(Date.now() - started < 5_000, "the run ended; it did not hang")
  assert.equal(existsSync(readFileSync(marker, "utf8")), false, "the per-task home is gone")
})

test("a home that cannot be removed does not replace the result of the run", async () => {
  const bin = await script(`
    const fs = require("node:fs")
    const locked = process.env.HOME + "/locked"
    fs.mkdirSync(locked)
    fs.writeFileSync(locked + "/f", "x")
    fs.chmodSync(locked, 0o500)
    process.stdout.write(JSON.stringify({ type: "text", sessionID: "ses_ok", part: { type: "text", text: "fine" } }) + "\\n")
  `)
  const lines: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => void lines.push(a.join(" "))
  let home = ""
  try {
    const run = await runOpencode({ goal: "g", dir: process.cwd(), bin, env: { GIBSON_CALLBACK_TOKEN: "g" } })
    assert.equal(run.text, "fine", "the result stands")
  } finally {
    console.error = orig
  }
  const logged = lines.find((l) => l.includes("could not remove the run directory"))
  assert.ok(logged, "the failure is logged")
  home = /run directory (\S+):/.exec(logged ?? "")?.[1] ?? ""
  if (home) {
    await chmod(join(home, "locked"), 0o700)
    await rm(home, { recursive: true, force: true })
  }
})

const uidNow = process.getuid?.() ?? 0
const baseName = (id: string): string => `zerocool-runs-${uidNow}-${id}`

test("removeStaleRunDirs removes only the old bases of other starts that this user owns", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerocool-stale-"))
  const now = Date.now()
  const make = async (name: string, ageMs: number, alive = true): Promise<void> => {
    await mkdir(join(root, name))
    await mkdir(join(root, name, "run-x"))
    const t = new Date(now - ageMs)
    if (alive) {
      await writeFile(join(root, name, ".alive"), "")
      await utimes(join(root, name, ".alive"), t, t)
    }
    await utimes(join(root, name), t, t)
  }
  const old = baseName("aaaaaaaaaaaaaaaa")
  const live = baseName("bbbbbbbbbbbbbbbb")
  const mine = baseName("cccccccccccccccc")
  const noHeartbeat = baseName("dddddddddddddddd")
  await make(old, 60 * 60_000) // nobody touched it for an hour
  await make(live, 60_000) // a live worker touched it a minute ago
  await make(mine, 60 * 60_000) // the base of this start, whatever its age
  await make(noHeartbeat, 60 * 60_000, false) // no heartbeat file: the base age counts
  await make("zerocool-runs-0-eeeeeeeeeeeeeeee", 60 * 60_000) // another user, by name
  await make("other-dir", 60 * 60_000) // not ours by name
  const removed = await removeStaleRunDirs({ root, now, bootId: "cccccccccccccccc" })
  assert.deepEqual(removed.sort(), [old, noHeartbeat].sort())
  for (const keep of [live, mine, "zerocool-runs-0-eeeeeeeeeeeeeeee", "other-dir"]) {
    assert.equal(existsSync(join(root, keep)), true, `${keep} stays`)
  }
})

test("removeStaleRunDirs skips a symbolic link, and never touches what it points at", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerocool-stale-"))
  const target = await mkdtemp(join(tmpdir(), "zerocool-target-"))
  await writeFile(join(target, "keep"), "x")
  const t = new Date(Date.now() - 60 * 60_000)
  await utimes(target, t, t)
  const link = baseName("ffffffffffffffff")
  await symlink(target, join(root, link))
  const removed = await removeStaleRunDirs({ root, bootId: "0000000000000000" })
  assert.deepEqual(removed, [])
  assert.equal(existsSync(join(target, "keep")), true, "the target is untouched")
})

test("a granted run lives under one 0700 base of this worker start, and the home goes after the run", async () => {
  const bin = fileURLToPath(new URL("../test/bin/fake-opencode-env.mjs", import.meta.url))
  const run = await runOpencode({ goal: "g", dir: process.cwd(), bin, env: { GIBSON_CALLBACK_TOKEN: "g" } })
  const home = (JSON.parse(run.text) as Record<string, string>).HOME
  const base = await runBaseDir()
  assert.equal(home.startsWith(`${base}/run-`), true, "the home is inside the base")
  assert.match(base, new RegExp(`/zerocool-runs-${uidNow}-[0-9a-f]{16}$`))
  assert.equal((await stat(base)).mode & 0o777, 0o700)
  assert.equal(existsSync(home), false)
})

/** A fake opencode that starts a background process in its own group, as a shell command of the model would. */
const WITH_GRANDCHILD = (pidFile: string, tail: string): string => `
  const fs = require("node:fs")
  const { spawn } = require("node:child_process")
  const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] })
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))
  ${tail}
`

const isDead = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  return false
}

test("a background process of the child is dead after a timeout", async () => {
  const pidFile = join(await mkdtemp(join(tmpdir(), "zerocool-pid-")), "pid")
  const bin = await script(WITH_GRANDCHILD(pidFile, "setInterval(() => {}, 1000)"))
  await assert.rejects(
    () => runOpencode({ goal: "g", dir: process.cwd(), bin, timeoutMs: 600, killGraceMs: 300, env: { GIBSON_CALLBACK_TOKEN: "g" } }),
    /timed out/,
  )
  assert.equal(await isDead(Number(readFileSync(pidFile, "utf8"))), true, "the grandchild is dead")
})

test("a background process of the child is dead after a normal end, even when it holds the pipes", async () => {
  const pidFile = join(await mkdtemp(join(tmpdir(), "zerocool-pid-")), "pid")
  const event = JSON.stringify({ type: "text", sessionID: "ses_ok", part: { type: "text", text: "done" } })
  const bin = await script(WITH_GRANDCHILD(pidFile, `process.stdout.write(${JSON.stringify(event + "\n")}); setTimeout(() => process.exit(0), 150)`))
  const run = await runOpencode({ goal: "g", dir: process.cwd(), bin, env: { GIBSON_CALLBACK_TOKEN: "g" } })
  assert.equal(run.text, "done")
  assert.equal(await isDead(Number(readFileSync(pidFile, "utf8"))), true, "the grandchild is dead")
})

test("a child that dies on a signal with no deadline is reported with the signal, not as a timeout", async () => {
  const bin = await script('process.kill(process.pid, "SIGKILL")')
  await assert.rejects(
    () => runOpencode({ goal: "g", dir: process.cwd(), bin, timeoutMs: 60_000 }),
    (e: Error) => e.message === "opencode was killed by SIGKILL",
  )
})

test("an invalid operator OPENCODE_CONFIG_CONTENT fails the run before any child starts", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "zerocool-marker-")), "started")
  const bin = await script(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`)
  const prev = process.env.OPENCODE_CONFIG_CONTENT
  try {
    for (const bad of ["{not json", "[1]", "null"]) {
      process.env.OPENCODE_CONFIG_CONTENT = bad
      await assert.rejects(
        () =>
          runOpencode({
            goal: "g",
            dir: process.cwd(),
            bin,
            env: { GIBSON_CALLBACK_TOKEN: "g", OPENCODE_CONFIG_CONTENT: '{"plugin":["file:///x"]}' },
          }),
        /OPENCODE_CONFIG_CONTENT (is not valid JSON|must be a JSON object)/,
        bad,
      )
    }
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = prev
  }
  assert.equal(existsSync(marker), false, "no child ran")
})

test("a granted child never gets OPENCODE_API_KEY, and a child with no grant keeps it", () => {
  const parent = { PATH: "/bin", OPENCODE_API_KEY: "oc-key", OPENCODE_CONFIG: "/etc/opencode.json" }
  const granted = opencodeChildEnv(parent, { GIBSON_CALLBACK_TOKEN: "g" })
  assert.equal(granted.OPENCODE_API_KEY, undefined)
  assert.equal(granted.OPENCODE_CONFIG, "/etc/opencode.json", "the operator config path stays")
  assert.equal(opencodeChildEnv(parent, {}).OPENCODE_API_KEY, "oc-key")
})

test("the plugin registration joins the operator OPENCODE_CONFIG_CONTENT and does not replace it", () => {
  const ours = JSON.stringify({ plugin: ["file:///app/dist/index.js"] })
  const merged = JSON.parse(
    opencodeChildEnv(
      { PATH: "/bin", OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ["@acme/extra", "file:///app/dist/index.js"], theme: "x" }) },
      { GIBSON_CALLBACK_TOKEN: "g", OPENCODE_CONFIG_CONTENT: ours },
    ).OPENCODE_CONFIG_CONTENT ?? "",
  )
  assert.deepEqual(merged.plugin, ["@acme/extra", "file:///app/dist/index.js"])
  assert.equal(merged.theme, "x")
  assert.equal(opencodeChildEnv({ PATH: "/bin" }, { GIBSON_CALLBACK_TOKEN: "g", OPENCODE_CONFIG_CONTENT: ours }).OPENCODE_CONFIG_CONTENT, ours)
  assert.throws(() => mergeConfigContent("not json", ours), /not valid JSON/)
})
