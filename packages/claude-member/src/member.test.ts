// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { ClaudeHandle, ClaudeRunOptions } from "./claude-run.js"
import { readMemberEnv, type MemberEnv } from "./env.js"
import { staticGrants, type DeliverableReport, type Inbox, type JobInput, type JobStateReport, type MemberStatus, type StatusReporter } from "./inbox.js"
import { JobTable, MemoryJobStore, type JobSpec } from "./job.js"
import { Member, type MemberDeps } from "./member.js"
import type { WorkspaceManager, WrapUpOutcome } from "./workspace.js"

let scratch = ""
function memberEnv(over: Record<string, string> = {}): MemberEnv {
  return readMemberEnv({
    ZEROCOOL_STATE_DIR: scratch,
    GIBSON_MEMBER_ID: "mem-1",
    GIBSON_BANK_ID: "bank-1",
    GIBSON_CG_JWT: "base-grant",
    GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
    ZEROCOOL_HEARTBEAT_MS: "10000",
    ...over,
  })
}

function spec(jobId: string): JobSpec {
  return { jobId, goal: `goal of ${jobId}`, repositories: [], credentialNames: [], inputNodeIds: [], acceptance: "", constraints: {} }
}

function input(jobId: string, over: Partial<JobInput> = {}): JobInput {
  return { jobId, kind: "open", text: "", grant: `grant-${jobId}`, sender: "user:ana", spec: spec(jobId), ...over }
}

class FakeInbox implements Inbox {
  queued: JobInput[] = []
  states: JobStateReport[] = []
  deliverables: DeliverableReport[] = []
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
}

class FakeStatus implements StatusReporter {
  reports: MemberStatus[] = []
  async reportStatus(s: MemberStatus): Promise<void> {
    this.reports.push(s)
  }
}

function fakeWorkspace(): WorkspaceManager & { wrapped: string[] } {
  const wrapped: string[] = []
  return {
    wrapped,
    prepare: async (jobId: string) => [{ repository: "api", path: `/workspace/jobs/${jobId}/api`, branch: `job/${jobId}`, deliverable: "MERGE_REQUEST" as const }],
    wrapUp: async (jobId: string): Promise<WrapUpOutcome[]> => {
      wrapped.push(jobId)
      return [{ repository: "api", branch: `job/${jobId}`, deliverable: "MERGE_REQUEST", commits: 1, pushed: true, mergeRequestUrl: "https://git.example/mr/1", error: "" }]
    },
    remove: async () => {},
    evict: async () => [],
    ensureClone: async () => "/clone",
    cached: () => [],
  } as unknown as WorkspaceManager & { wrapped: string[] }
}

/** A spawn seam that records the run options and settles when the test says so. */
function recorder() {
  const calls: ClaudeRunOptions[] = []
  const finish: ((over?: { stderr?: string }) => void)[] = []
  const spawn = (o: ClaudeRunOptions): ClaudeHandle => {
    calls.push(o)
    let resolve!: (over?: { stderr?: string }) => void
    // Claude Code keeps the session id across --resume; a new session gets a new one.
    const sessionId = o.resume ?? `sess-${calls.length}`
    const done = new Promise<{ stderr?: string } | undefined>((r) => (resolve = r)).then((over) => ({
      text: "turn done",
      sessionId,
      isError: false,
      resultSubtype: "success",
      numTurns: 1,
      costUsd: 0.5,
      mcpServerErrors: [],
      toolCalls: [],
      events: 3,
      sawResult: true,
      stderr: "",
      exitCode: 0 as number | null,
      signal: null,
      ...over,
    }))
    finish.push(resolve)
    return { done, interrupt: () => resolve(), kill: () => resolve(), pid: 1 }
  }
  const finishWith = (i: number, over: { stderr?: string }) => finish[i]!(over)
  return { calls, finish, finishWith, spawn }
}

function member(over: Partial<MemberDeps> = {}, cap = 1) {
  scratch = mkdtempSync(join(tmpdir(), "zc-member-"))
  const inbox = new FakeInbox()
  const status = new FakeStatus()
  const workspace = fakeWorkspace()
  const table = new JobTable({ cap, store: new MemoryJobStore() })
  const rec = recorder()
  const m = new Member({
    env: memberEnv({ ZEROCOOL_JOB_CAP: String(cap) }),
    processEnv: {},
    table,
    inbox,
    grants: staticGrants("base-grant"),
    status,
    workspace,
    claudeCodeVersion: "2.1.257",
    spawn: rec.spawn,
    idlePollMs: 5,
    ...over,
  })
  return { m, inbox, status, workspace, table, rec }
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 15))
}

test("a pulled job opens, prepares a worktree and runs its first turn", async () => {
  const { m, inbox, table, rec } = member()
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  assert.equal(table.get("job-1").state, "working")
  assert.equal(rec.calls.length, 1)
  assert.match(rec.calls[0]!.input!, /goal of job-1/)
  assert.match(rec.calls[0]!.appendSystemPrompt!, /job job-1/)
  rec.finish[0]!()
  await settle()
  assert.equal(table.get("job-1").state, "waiting")
  assert.equal(table.get("job-1").claudeSessionId, "sess-1")
  assert.equal(table.get("job-1").costUsd, 0.5)
  ac.abort()
  await run
})

test("with a cap of one the second job waits until the first turn ends", async () => {
  const { m, inbox, table, rec } = member({}, 1)
  inbox.queued.push(input("job-1"), input("job-2"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  assert.equal(rec.calls.length, 1, "the cap bounds turns in flight")
  assert.equal(table.has("job-2"), false)
  rec.finish[0]!()
  await settle()
  assert.equal(rec.calls.length, 2)
  assert.equal(table.get("job-2").state, "working")
  ac.abort()
  rec.finish[1]!()
  await run
})

test("a later input on a held job resumes the same Claude Code session", async () => {
  const { m, inbox, rec } = member()
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()

  await inbox.deliver(input("job-1", { kind: "turn", text: "the verifier failed on pass one", spec: undefined, grant: "verifier-grant" }))
  await settle()
  assert.equal(rec.calls.length, 2)
  assert.equal(rec.calls[1]!.resume, "sess-1", "the same job is the same conversation")
  assert.equal(rec.calls[1]!.input, "the verifier failed on pass one")
  ac.abort()
  rec.finish[1]!()
  await run
})

test("a close input wraps up, reports the deliverable and drops the job", async () => {
  const { m, inbox, table, workspace, rec } = member()
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()

  await inbox.deliver({ jobId: "job-1", kind: "close", text: "verified", grant: "scorer-grant", sender: "component:agent:verifier", verdict: "accomplished", score: 95 })
  await settle()
  assert.deepEqual(workspace.wrapped, ["job-1"])
  assert.equal(inbox.deliverables.length, 1)
  assert.equal(inbox.deliverables[0]!.mergeRequestUrl, "https://git.example/mr/1")
  assert.equal(table.has("job-1"), false, "a closed job leaves the table after cleanup")
  ac.abort()
  await run
})

test("the heartbeat reports idle, then busy at the cap, with the job ids and the CLI version", async () => {
  const { m, inbox, status, rec } = member()
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle(2)
  assert.equal(status.reports[0]!.state, "idle")
  assert.equal(status.reports[0]!.cap, 1)
  assert.equal(status.reports[0]!.claudeCodeVersion, "2.1.257")
  assert.equal(status.reports[0]!.memberId, "mem-1")
  assert.equal(status.reports[0]!.bankId, "bank-1")

  inbox.queued.push(input("job-1"))
  await settle()
  const busy = m.status()
  assert.equal(busy.state, "busy")
  assert.equal(busy.jobsInFlight, 1)
  assert.deepEqual(busy.jobs, ["job-1"])
  ac.abort()
  rec.finish[0]!()
  await run
})

test("a member reports launching until it has read its job table", async () => {
  const { m } = member()
  assert.equal(m.status().state, "launching")
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle(2)
  assert.equal(m.status().state, "idle")
  ac.abort()
  await run
})

test("a member that must sign in reports needs_sign_in whatever its jobs are doing", async () => {
  const { m, inbox, rec } = member({ needsSignIn: () => true })
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle(2)
  assert.equal(m.status().state, "needs_sign_in")
  inbox.queued.push(input("job-1"))
  await settle()
  assert.equal(m.status().state, "needs_sign_in", "a busy member that must sign in still says so")
  ac.abort()
  rec.finish[0]?.()
  await run
})

test("a member that is stopping reports draining", async () => {
  const { m, inbox, rec } = member()
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  ac.abort()
  assert.equal(m.status().state, "draining")
  rec.finish[0]?.()
  await run
})

test("stopping interrupts the running turn instead of killing it", async () => {
  const { m, inbox, table } = member()
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  assert.equal(table.get("job-1").state, "working")
  ac.abort()
  await run
  assert.equal(table.get("job-1").state, "waiting", "the job is left resumable, not lost")
})

test("every turn runs under the grant of its own input", async () => {
  const grants: [string, string][] = []
  const { m, inbox, rec } = member({ mcp: { url: "http://127.0.0.1:7455/mcp", useGrant: async (j: string, g: string) => void grants.push([j, g]), release: async () => {} } })
  inbox.queued.push(input("job-1", { grant: "dispatch-grant-1" }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  await inbox.deliver(input("job-1", { kind: "turn", text: "next", spec: undefined, grant: "dispatch-grant-2" }))
  await settle()
  assert.deepEqual(grants, [
    ["job-1", "dispatch-grant-1"],
    ["job-1", "dispatch-grant-2"],
  ])
  ac.abort()
  rec.finish[1]!()
  await run
})

test("a job state report reaches the daemon on every turn boundary", async () => {
  const { m, inbox, rec } = member()
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  const states = inbox.states.map((s) => s.state)
  assert.deepEqual(states.slice(0, 2), ["working", "waiting"])
  assert.equal(inbox.states[1]!.claudeSessionId, "sess-1")
  assert.equal(inbox.states[1]!.detail, "turn done")
  assert.equal(inbox.states[1]!.isError, false)
  ac.abort()
  await run
})

test("an expiring subscription login is reported once a day, from the turn's stderr", async () => {
  const expiring: number[] = []
  const { m, inbox, rec } = member({
    signInRelay: {
      reportPrompt: async () => {},
      reportInvalidCode: async () => {},
      reportSignedIn: async () => {},
      reportFailed: async () => {},
      reportExpiring: async (days: number) => {
        expiring.push(days)
      },
    },
  })
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finishWith(0, { stderr: "Warning: login expires in 4 days" })
  await settle()
  await inbox.deliver(input("job-1", { kind: "turn", text: "again", spec: undefined }))
  await settle()
  rec.finishWith(1, { stderr: "Warning: login expires in 4 days" })
  await settle()
  assert.deepEqual(expiring, [4], "the same day reports once, not on every turn")
  ac.abort()
  await run
})

test("the heartbeat carries the days until the subscription login expires", async () => {
  const { m, inbox, rec } = member()
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  assert.equal(m.status().signInExpiresInDays, -1, "no warning means no expiry to report")
  rec.finishWith(0, { stderr: "Warning: login expires in 4 days" })
  await settle()
  assert.equal(m.status().signInExpiresInDays, 4)
  assert.equal(m.status().state, "idle", "an expiring login still works")
  ac.abort()
  await run
})

// ---------------------------------------------------------------------------
// D3: wrap-up, close, abandon, archive, resume after a restart (#107)
// ---------------------------------------------------------------------------

import { mkdir, writeFile } from "node:fs/promises"
import { projectDir, type SessionStore } from "./transcript.js"

function sessionStore(): SessionStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>()
  return { blobs, put: async (k, d) => void blobs.set(k, new Uint8Array(d)), get: async (k) => blobs.get(k) }
}

test("a wrap_up input runs one last turn with the wrap-up prompt, then closes, archives and drops the job", async () => {
  const sessions = sessionStore()
  const { m, inbox, table, workspace, rec } = member({ sessions })
  const configDir = m["deps"].env.claudeConfigDir
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  // Claude Code wrote the session's transcript during that turn.
  const dir = projectDir(configDir, "/workspace/jobs/job-1/api")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "sess-1.jsonl"), '{"type":"user"}\n')

  await inbox.deliver({ jobId: "job-1", kind: "wrap_up", text: "verifier passed on pass two", grant: "scorer-grant", sender: "component:agent:verifier", verdict: "accomplished", score: 92 })
  await settle()
  assert.equal(rec.calls.length, 2, "the wrap-up is one more turn")
  assert.match(rec.calls[1]!.input!, /This job is being closed/)
  assert.match(rec.calls[1]!.input!, /From the scorer: verifier passed on pass two/)
  assert.equal(rec.calls[1]!.resume, "sess-1", "on the same session")
  assert.equal(workspace.wrapped.length, 0, "cleanup waits for the wrap-up turn to end")

  rec.finish[1]!()
  await settle()
  assert.deepEqual(workspace.wrapped, ["job-1"])
  assert.equal(table.has("job-1"), false, "dropped after cleanup")
  assert.ok(sessions.blobs.has("job-1"), "the transcript manifest reached the session store")
  assert.equal(inbox.deliverables.length, 1)
  const closed = inbox.states.find((s) => s.state === "closed")!
  assert.match(closed.detail, /accomplished/)
  ac.abort()
  await run
})

test("a close input closes without a final turn, and still archives", async () => {
  const sessions = sessionStore()
  const { m, inbox, table, rec } = member({ sessions })
  const configDir = m["deps"].env.claudeConfigDir
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  const dir = projectDir(configDir, "/workspace/jobs/job-1/api")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "sess-1.jsonl"), "{}\n")
  await inbox.deliver({ jobId: "job-1", kind: "close", text: "", grant: "g", sender: "user:ana", verdict: "failed", score: 10 })
  await settle()
  assert.equal(rec.calls.length, 1, "no final turn")
  assert.equal(table.has("job-1"), false)
  assert.ok(sessions.blobs.has("job-1"))
  ac.abort()
  await run
})

test("a relaunched member restores the transcript from the store and resumes the same session", async () => {
  const sessions = sessionStore()
  // What the old sandbox archived before it died.
  const manifest = { version: 1, sessionId: "sess-old", cwd: "/workspace/jobs/job-1/api", files: [{ path: "-workspace-jobs-job-1-api/sess-old.jsonl", bytes: 3, chunks: ["job-1/0"] }], archivedAt: 1 }
  sessions.blobs.set("job-1", new TextEncoder().encode(JSON.stringify(manifest)))
  sessions.blobs.set("job-1/0", new TextEncoder().encode("{}\n"))

  const { m, inbox, rec, table } = member({ sessions })
  // The daemon hands the job back with the session it recorded.
  inbox.queued.push(input("job-1", { claudeSessionId: "sess-old" }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  assert.equal(rec.calls.length, 1)
  assert.equal(rec.calls[0]!.resume, "sess-old", "the first turn after a relaunch resumes, it does not start over")
  assert.equal(table.get("job-1").claudeSessionId, "sess-old")
  const restored = join(projectDir(m["deps"].env.claudeConfigDir, "/workspace/jobs/job-1/api"), "sess-old.jsonl")
  assert.equal(await readFile(restored, "utf8"), "{}\n", "the transcript is back where --resume looks")
  ac.abort()
  rec.finish[0]!()
  await run
})

test("stopping the member archives every live job and reports that it is stopping", async () => {
  const sessions = sessionStore()
  const { m, inbox, rec } = member({ sessions, stopGraceMs: 2000 })
  const configDir = m["deps"].env.claudeConfigDir
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  const dir = projectDir(configDir, "/workspace/jobs/job-1/api")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "sess-1.jsonl"), "{}\n")
  ac.abort()
  await run
  assert.ok(sessions.blobs.has("job-1"), "archived on the way out")
  assert.ok(inbox.states.some((s) => s.detail === "member stopping"))
})
