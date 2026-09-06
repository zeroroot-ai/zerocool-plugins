// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { readMemberEnv } from "./env.js"
import { staticGrants, type DeliverableReport, type Inbox, type JobInput, type JobStateReport, type MemberStatus, type StatusReporter } from "./inbox.js"
import { JobTable, MemoryJobStore, type JobSpec } from "./job.js"
import { Member } from "./member.js"
import { WorkspaceManager } from "./workspace.js"

/**
 * The driver end to end: the real `spawnClaude`, the real argv, a fake
 * `claude` bin that replays a captured stream-json fixture and records what it
 * was called with. The seams a test replaces are the daemon ones only
 * (zerocool-plugins#105, the acceptance clause).
 */
const FAKE = fileURLToPath(new URL("../test/bin/fake-claude.mjs", import.meta.url))
const FIXTURE = fileURLToPath(new URL("../test/fixtures/claude-code-2.1.257/job-turn-synthetic.jsonl", import.meta.url))

interface Call {
  argv: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  stdin: string
}

async function calls(record: string): Promise<Call[]> {
  const raw = await readFile(record, "utf8").catch(() => "")
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Call)
}

function spec(jobId: string): JobSpec {
  return { jobId, goal: `goal of ${jobId}`, repositories: [], credentialNames: [], inputNodeIds: [], acceptance: "", constraints: {} }
}

function open(jobId: string): JobInput {
  return { jobId, kind: "open", text: "", grant: `grant-${jobId}`, sender: "user:ana", spec: spec(jobId) }
}

class Daemon implements Inbox, StatusReporter {
  queued: JobInput[] = []
  states: JobStateReport[] = []
  deliverables: DeliverableReport[] = []
  statuses: MemberStatus[] = []
  private handler: ((i: JobInput) => Promise<void>) | undefined

  async subscribe(onInput: (i: JobInput) => Promise<void>, signal: AbortSignal): Promise<void> {
    this.handler = onInput
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener("abort", () => resolve(), { once: true })
    })
  }
  async deliver(i: JobInput): Promise<void> {
    await this.handler?.(i)
  }
  async pull(): Promise<JobInput | undefined> {
    return this.queued.shift()
  }
  async reportState(r: JobStateReport): Promise<void> {
    this.states.push(r)
  }
  async reportDeliverable(r: DeliverableReport): Promise<void> {
    this.deliverables.push(r)
  }
  async reportStatus(s: MemberStatus): Promise<void> {
    this.statuses.push(s)
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error("timed out waiting for the driver")
}

async function harness(cap: number, hangMs = "0") {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-e2e-"))
  const events: string[] = []
  const record = join(dir, "calls.jsonl")
  await mkdir(join(dir, "workspace"), { recursive: true })
  const daemon = new Daemon()
  const env = readMemberEnv({
    GIBSON_MEMBER_ID: "mem-1",
    GIBSON_BANK_ID: "bank-1",
    GIBSON_CG_JWT: "base-grant",
    GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
    ZEROCOOL_JOB_CAP: String(cap),
    ZEROCOOL_WORKSPACE: join(dir, "workspace"),
    ZEROCOOL_STATE_DIR: join(dir, "state"),
    ZEROCOOL_CLAUDE_BIN: FAKE,
    ZEROCOOL_HEARTBEAT_MS: "50",
  })
  const table = new JobTable({ cap, store: new MemoryJobStore() })
  const deps = {
    env,
    processEnv: { PATH: process.env.PATH ?? "", HOME: dir, CLAUDE_FAKE_FIXTURE: FIXTURE, CLAUDE_FAKE_RECORD: record, CLAUDE_FAKE_HANG_MS: hangMs, GIBSON_CG_JWT: "base-grant", ZEROCOOL_MCP_URL: "http://127.0.0.1:1/mcp" } as NodeJS.ProcessEnv,
    table,
    inbox: daemon,
    grants: staticGrants("base-grant"),
    status: daemon,
    workspace: new WorkspaceManager({ root: join(dir, "workspace"), stateDir: join(dir, "state"), capBytes: 1 << 30, credential: async () => "unused" }),
    claudeCodeVersion: "2.1.257",
    idlePollMs: 25,
    onEvent: (_jobId: string, line: string) => events.push(line),
  }
  const member = new Member(deps)
  return { dir, record, daemon, table, member, deps, events, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("end to end: the driver runs a real claude process, and the second turn resumes the recorded session", async () => {
  const h = await harness(1)
  try {
    h.daemon.queued.push(open("job-1"))
    const ac = new AbortController()
    const run = h.member.run(ac.signal)

    await waitFor(() => h.table.has("job-1") && h.table.get("job-1").state === "waiting")
    assert.equal(h.table.get("job-1").claudeSessionId, "9d3f0f1e-1a4f-4a1e-9d61-2c0a1b2c3d4e", "the session id comes from the fixture's system/init")
    assert.equal(h.table.get("job-1").costUsd, 0.4231)

    await h.daemon.deliver({ jobId: "job-1", kind: "turn", text: "the verifier failed on pass one", grant: "verifier-grant", sender: "component:agent:verifier" })
    await waitFor(async () => (await calls(h.record)).length === 2 && h.table.get("job-1").turns === 2)

    const seen = await calls(h.record)
    assert.equal(seen.length, 2)
    assert.ok(!seen[0]!.argv.includes("--resume"), "the first turn starts a session")
    assert.equal(seen[1]!.argv[seen[1]!.argv.indexOf("--resume") + 1], "9d3f0f1e-1a4f-4a1e-9d61-2c0a1b2c3d4e")
    assert.equal(JSON.parse(seen[1]!.stdin.trim()).message.content[0].text, "the verifier failed on pass one")

    ac.abort()
    await run
  } finally {
    await h.cleanup()
  }
})

test("end to end: the real argv carries the headless flags, the prompt and the config dir", async () => {
  const h = await harness(1)
  try {
    h.daemon.queued.push(open("job-1"))
    const ac = new AbortController()
    const run = h.member.run(ac.signal)
    await waitFor(async () => (await calls(h.record)).length === 1)
    const call = (await calls(h.record))[0]!

    for (const flag of ["-p", "--input-format", "--output-format", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions", "--append-system-prompt", "--max-turns"]) {
      assert.ok(call.argv.includes(flag), `missing ${flag}`)
    }
    assert.ok(!call.argv.includes("--no-session-persistence"), "a member turn must stay resumable")
    assert.match(call.argv[call.argv.indexOf("--append-system-prompt") + 1]!, /job job-1/)
    assert.match(String(call.env.CLAUDE_CONFIG_DIR), /claude-config$/)
    assert.equal(call.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1")

    ac.abort()
    await run
  } finally {
    await h.cleanup()
  }
})

test("end to end: no grant, no workspace knob and no git token reaches the claude process", async () => {
  const h = await harness(1)
  try {
    h.daemon.queued.push(open("job-1"))
    const ac = new AbortController()
    const run = h.member.run(ac.signal)
    await waitFor(async () => (await calls(h.record)).length === 1)
    const call = (await calls(h.record))[0]!

    assert.equal(call.env.GIBSON_CG_JWT, undefined, "the base grant stays in the driver")
    assert.equal(call.env.ZEROCOOL_MCP_URL, undefined)
    assert.equal(call.env.ZEROCOOL_GIT_TOKEN, undefined)
    assert.ok(!JSON.stringify(call.argv).includes("base-grant"), "no grant on argv")

    ac.abort()
    await run
  } finally {
    await h.cleanup()
  }
})

test("end to end: with a cap of one the second job waits, then runs when the slot frees", async () => {
  const h = await harness(1)
  try {
    h.daemon.queued.push(open("job-1"), open("job-2"))
    const ac = new AbortController()
    const run = h.member.run(ac.signal)

    await waitFor(() => h.table.has("job-2") && h.table.get("job-2").state === "waiting")
    const seen = await calls(h.record)
    assert.equal(seen.length, 2, "both jobs ran, one at a time")
    const goals = seen.map((c) => JSON.parse(c.stdin.trim()).message.content[0].text as string)
    assert.ok(goals[0]!.startsWith("goal of job-1"))
    assert.ok(goals[1]!.startsWith("goal of job-2"))
    assert.ok(h.daemon.statuses.some((s) => s.state === "busy"), "the heartbeat reported busy while a turn ran")

    ac.abort()
    await run
  } finally {
    await h.cleanup()
  }
})

test("end to end: stopping the member interrupts the turn and leaves the job resumable", async () => {
  const h = await harness(1, "5000")
  try {
    h.daemon.queued.push(open("job-1"))
    const ac = new AbortController()
    const run = h.member.run(ac.signal)
    // Wait for the turn to be really running: the first event means the
    // process is up and past exec, so the signal reaches Claude Code itself.
    await waitFor(() => h.events.length > 0)
    ac.abort()
    await run
    assert.equal(h.table.get("job-1").state, "waiting")
    assert.ok(h.table.get("job-1").claudeSessionId.length > 0, "the session survives, so the job resumes")
    // SIGINT is why the driver stops a turn that way: Claude Code records a
    // result for it, so the job is left waiting rather than half finished.
    assert.equal(h.table.get("job-1").recovered, false)
  } finally {
    await h.cleanup()
  }
})

test("end to end: the turn attaches the MCP server over localhost HTTP with the ask tool", async () => {
  const h = await harness(1)
  try {
    const grants: [string, string][] = []
    const released: string[] = []
    const gateway = {
      url: "http://127.0.0.1:7788/mcp",
      useGrant: async (jobId: string, grant: string) => void grants.push([jobId, grant]),
      release: async (jobId: string) => void released.push(jobId),
    }
    const member = new Member({ ...h.deps, mcp: gateway })
    h.daemon.queued.push(open("job-1"))
    const ac = new AbortController()
    const run = member.run(ac.signal)
    await waitFor(async () => (await calls(h.record)).length === 1)
    const call = (await calls(h.record))[0]!

    const config = JSON.parse(call.argv[call.argv.indexOf("--mcp-config") + 1]!) as { mcpServers: { gibson: { type: string; url: string } } }
    assert.deepEqual(config.mcpServers.gibson, { type: "http", url: "http://127.0.0.1:7788/mcp" })
    assert.ok(call.argv.includes("--strict-mcp-config"), "only the server the driver names")
    assert.equal(call.argv[call.argv.indexOf("--permission-prompt-tool") + 1], "mcp__gibson__ask")
    assert.deepEqual(grants, [["job-1", "grant-job-1"]], "the grant is in force before Claude Code starts")

    await waitFor(() => released.length === 1)
    assert.deepEqual(released, ["job-1"], "and released when the turn ends")
    ac.abort()
    await run
  } finally {
    await h.cleanup()
  }
})
