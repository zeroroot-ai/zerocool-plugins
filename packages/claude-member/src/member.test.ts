// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Code, ConnectError } from "@connectrpc/connect"
import type { ClaudeHandle, ClaudeRunOptions } from "./claude-run.js"
import { readMemberEnv, type MemberEnv } from "./env.js"
import { ComponentHeartbeat } from "./heartbeat.js"
import { type DeliverableReport, type GrantSource, type Inbox, type JobInput, type JobStateReport, type MemberStatus, type StatusReporter } from "./inbox.js"
import { JobTable, MemoryJobStore, type JobSpec } from "./job.js"
import { Member, SIGN_IN_JOB_ID, SIGN_IN_START, type MemberDeps, type SignInAttempt } from "./member.js"
import type { WorkspaceManager, WrapUpOutcome } from "./workspace.js"

/** A grant source with the base grant only. Inputs carry their own or fall back. */
const staticGrants = (baseGrant: string): GrantSource => ({ baseGrant: () => baseGrant, grantFor: (input) => input.grant || baseGrant, turnGrant: (input) => input.grant || undefined })

let scratch = ""
function memberEnv(over: Record<string, string> = {}): MemberEnv {
  return readMemberEnv({
    ZEROCOOL_STATE_DIR: scratch,
    GIBSON_MEMBER_ID: "mem-1",
    GIBSON_BANK_ID: "bank-1",
    GIBSON_CG_JWT: "base-grant",
    GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
  GIBSON_SANDBOX: "launcher",
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

type FakeWorkspace = WorkspaceManager & { wrapped: string[]; wrapGrants: string[]; prepareGrants: string[]; resumedFlags: boolean[]; removed: string[] }

/** `outcomes` is one list of outcome overrides per wrap-up try. The last one repeats. */
function fakeWorkspace(opts: { prepareError?: Error; outcomes?: Partial<WrapUpOutcome>[][]; wrapDelayMs?: number } = {}): FakeWorkspace {
  const wrapped: string[] = []
  const wrapGrants: string[] = []
  const prepareGrants: string[] = []
  const resumedFlags: boolean[] = []
  const removed: string[] = []
  let tries = 0
  return {
    wrapped,
    wrapGrants,
    prepareGrants,
    resumedFlags,
    removed,
    prepare: async (jobId: string, _repos: unknown, grant: string | undefined, o: { resumed: boolean }) => {
      prepareGrants.push(grant ?? "none")
      resumedFlags.push(o.resumed)
      if (opts.prepareError) throw opts.prepareError
      return [{ repository: "api", path: `/workspace/jobs/${jobId}/api`, branch: `job/${jobId}`, deliverable: "MERGE_REQUEST" as const, notes: [] }]
    },
    fetchFile: async () => ({ ok: true, text: "" }),
    wrapUp: async (jobId: string, _repos: unknown, o: { grant: string | undefined }): Promise<WrapUpOutcome[]> => {
      wrapped.push(jobId)
      wrapGrants.push(o.grant ?? "none")
      if (opts.wrapDelayMs) await new Promise((r) => setTimeout(r, opts.wrapDelayMs))
      const over = (opts.outcomes ?? [[{}]])[Math.min(tries++, (opts.outcomes ?? [[{}]]).length - 1)]!
      return over.map((x) => ({
        repository: "api",
        branch: `job/${jobId}`,
        deliverable: "MERGE_REQUEST" as const,
        files: 1,
        mergeRequest: "acme/api#1",
        mergeRequestUrl: "https://git.example/mr/1",
        error: "",
        failed: false,
        retryable: false,
        ...x,
      }))
    },
    remove: async (jobId: string) => {
      removed.push(jobId)
    },
  } as unknown as FakeWorkspace
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

test("the wrap-up calls the connector tools under the grant of the latest input", async () => {
  const workspace = fakeWorkspace()
  const { m, inbox, rec } = member({ workspace })
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  await inbox.deliver({ jobId: "job-1", kind: "close", text: "verified", grant: "scorer-grant", sender: "component:agent:verifier", verdict: "accomplished", score: 95 })
  await settle()
  assert.deepEqual(workspace.prepareGrants, ["grant-job-1"], "the base tree is read under the grant of the opening turn")
  assert.deepEqual(workspace.wrapGrants, ["scorer-grant"])
  assert.equal(inbox.deliverables[0]!.mergeRequest, "acme/api#1")
  ac.abort()
  await run
})

test("a refused workspace, such as a truncated tree, closes the job as failed and delivers nothing", async () => {
  const { DeliveryRefused } = await import("./workspace.js")
  const workspace = fakeWorkspace({ prepareError: new DeliveryRefused("The host cut the tree of acme/api at main.") })
  const lines: string[] = []
  const { m, inbox, table, rec } = member({ workspace, onEvent: (_id: string, line: string) => lines.push(line) })
  const repo = { name: "api", connectorRef: "connector/acme", project: "acme/api", baseBranch: "main", deliverable: "MERGE_REQUEST" as const }
  inbox.queued.push(input("job-1", { spec: { ...spec("job-1"), repositories: [repo] } }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  assert.equal(rec.calls.length, 0, "no turn runs on a refused workspace")
  assert.equal(workspace.wrapped.length, 0, "no merge request is opened")
  assert.equal(table.has("job-1"), false)
  assert.equal(inbox.deliverables.length, 1)
  assert.equal(inbox.deliverables[0]!.mergeRequestUrl, "")
  assert.match(inbox.deliverables[0]!.error, /cut the tree/)
  assert.ok(inbox.states.some((s) => s.state === "closed" && s.isError && /cut the tree/.test(s.detail)))
  assert.ok(lines.some((l) => l.includes("workspace_refused") && l.includes("cut the tree")), "the console shows the refusal")
  assert.deepEqual(workspace.removed, ["job-1"])
  ac.abort()
  await run
})

const repoSpec = (jobId: string) => ({ ...spec(jobId), repositories: [{ name: "api", connectorRef: "connector/acme", project: "acme/api", baseBranch: "main", deliverable: "MERGE_REQUEST" as const }] })

test("a pulled job with no grant of a turn prepares with no grant, and never with the base grant", async () => {
  const workspace = fakeWorkspace()
  const { m, inbox, rec } = member({ workspace })
  inbox.queued.push(input("job-1", { grant: "", spec: repoSpec("job-1") }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  assert.deepEqual(workspace.prepareGrants, ["none"])
  assert.equal(rec.calls.length, 1, "the turn still runs")
  ac.abort()
  rec.finish[0]!()
  await run
})

test("a job that came back after a restart tells prepare that it was resumed", async () => {
  const workspace = fakeWorkspace()
  const { m, inbox, rec } = member({ workspace })
  inbox.queued.push(input("job-1", { claudeSessionId: "sess-old" }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  assert.deepEqual(workspace.resumedFlags, [true])
  ac.abort()
  rec.finish[0]!()
  await run
})

test("a failed delivery reports the closed job as an error and keeps no merge request", async () => {
  const workspace = fakeWorkspace({ outcomes: [[{ mergeRequest: "", mergeRequestUrl: "", error: "The change has 101 files.", failed: true }]] })
  const { m, inbox, rec } = member({ workspace })
  inbox.queued.push(input("job-1", { spec: repoSpec("job-1") }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  await inbox.deliver({ jobId: "job-1", kind: "close", text: "", grant: "scorer-grant", sender: "component:agent:verifier", verdict: "accomplished", score: 95 })
  await settle()
  const closed = inbox.states.filter((s) => s.state === "closed")
  assert.ok(closed.length > 0 && closed.every((s) => s.isError), "a refused delivery is a failed job, whatever the verdict was")
  assert.match(closed[0]!.detail, /delivery failed: The change has 101 files/)
  assert.deepEqual(workspace.removed, ["job-1"], "a permanent refusal ends the workspace")
  ac.abort()
  await run
})

test("a transient failure is tried again inside the close, with backoff, and then delivers", async () => {
  const workspace = fakeWorkspace({
    outcomes: [[{ mergeRequest: "", mergeRequestUrl: "", error: "open_merge_request: the host is busy", failed: true, retryable: true }], [{}]],
  })
  const lines: string[] = []
  const { m, inbox, table, rec } = member({ workspace, deliverRetryMs: 5000, deliverBackoffMs: 5, onEvent: (_id: string, line: string) => lines.push(line) })
  inbox.queued.push(input("job-1", { spec: repoSpec("job-1") }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  await inbox.deliver({ jobId: "job-1", kind: "close", text: "", grant: "scorer-grant", sender: "component:agent:verifier", verdict: "accomplished", score: 95 })
  await settle(10)
  assert.deepEqual(workspace.wrapGrants, ["scorer-grant", "scorer-grant"], "the second try is inside the same close")
  assert.ok(lines.some((l) => l.includes("delivery_waiting")))
  assert.equal(inbox.deliverables.at(-1)!.mergeRequest, "acme/api#1")
  assert.deepEqual(workspace.removed, ["job-1"])
  assert.equal(table.has("job-1"), false)
  assert.ok(inbox.states.filter((s) => s.state === "closed").every((s) => !s.isError))
  ac.abort()
  await run
})

test("when the tries run out the job is failed with its reason, the workspace is removed and the record is dropped", async () => {
  const workspace = fakeWorkspace({
    outcomes: [[{ mergeRequest: "", mergeRequestUrl: "", error: "open_merge_request: the host is busy", failed: true, retryable: true }]],
  })
  const { m, inbox, table, rec } = member({ workspace, deliverRetryMs: 60, deliverBackoffMs: 10 })
  inbox.queued.push(input("job-1", { spec: repoSpec("job-1") }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  await inbox.deliver({ jobId: "job-1", kind: "close", text: "", grant: "scorer-grant", sender: "component:agent:verifier", verdict: "accomplished", score: 95 })
  await settle(15)
  assert.ok(workspace.wrapped.length >= 2, "it was tried more than once")
  assert.deepEqual(workspace.removed, ["job-1"], "nothing outlives the close")
  assert.equal(table.has("job-1"), false)
  const closed = inbox.states.filter((s) => s.state === "closed")
  assert.ok(closed.length > 0 && closed.every((s) => s.isError))
  assert.match(closed[0]!.detail, /the host is busy.*The tries ended after/)
  assert.match(inbox.deliverables.at(-1)!.error, /The tries ended after/)
  ac.abort()
  await run
})

test("the Member itself refuses a cap above one when fetch_file is wired, and accepts a cap of one", () => {
  const mcp = { register: () => ({ url: "http://127.0.0.1:1/t/x/mcp", dispose: () => {} }), stop: async () => {} }
  assert.throws(() => member({ workspaceMcp: mcp }, 2), /ZEROCOOL_JOB_CAP is 2, and fetch_file is wired/)
  assert.doesNotThrow(() => member({ workspaceMcp: mcp }, 1))
})

test("a close delivers off the pump: the slot stays counted, and a stop ends the wait and the tries within the stop deadline", async () => {
  const workspace = fakeWorkspace({
    outcomes: [[{ mergeRequest: "", mergeRequestUrl: "", error: "open_merge_request: the host is busy", failed: true, retryable: true }]],
  })
  const { m, inbox, table, rec } = member({ workspace, deliverRetryMs: 600_000, deliverBackoffMs: 600_000, deliverStopMs: 150 })
  inbox.queued.push(input("job-1", { spec: repoSpec("job-1") }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  await inbox.deliver({ jobId: "job-1", kind: "close", text: "", grant: "scorer-grant", sender: "component:agent:verifier", verdict: "accomplished", score: 95 })
  await settle()
  assert.equal(workspace.wrapped.length, 1, "the first try ran, and the delivery now waits ten minutes")
  assert.equal(m.status().jobsInFlight, 1, "the closed job keeps its slot while it delivers")
  assert.deepEqual(m.status().jobs, ["job-1"])
  inbox.queued.push(input("job-2"))
  await settle()
  assert.equal(table.has("job-2"), false, "the cap of one holds while the delivery waits")
  assert.equal(rec.calls.length, 1)

  const stopped = Date.now()
  ac.abort()
  await run
  assert.ok(Date.now() - stopped < 3000, "the stop woke the wait, and the stop deadline ended the tries")
  assert.ok(workspace.wrapped.length >= 2, "a stop does not fail the job at the first error: it tries again until the stop deadline")
  assert.deepEqual(workspace.removed, ["job-1"])
  assert.match(inbox.deliverables.at(-1)!.error, /The member is stopping, and the tries ended after/)
  assert.equal(table.has("job-1"), false)
})

test("a stop during a transient failure tries again at once, and delivers when the retry succeeds", async () => {
  const workspace = fakeWorkspace({
    outcomes: [[{ mergeRequest: "", mergeRequestUrl: "", error: "open_merge_request: the host is busy", failed: true, retryable: true }], [{}]],
  })
  const { m, inbox, table, rec } = member({ workspace, deliverRetryMs: 600_000, deliverBackoffMs: 600_000, deliverStopMs: 5000 })
  inbox.queued.push(input("job-1", { spec: repoSpec("job-1") }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  await inbox.deliver({ jobId: "job-1", kind: "close", text: "", grant: "scorer-grant", sender: "component:agent:verifier", verdict: "accomplished", score: 95 })
  await settle()
  assert.equal(workspace.wrapped.length, 1)
  ac.abort()
  await run
  assert.equal(workspace.wrapped.length, 2, "the stop woke the wait and the second try ran")
  assert.equal(inbox.deliverables.at(-1)!.mergeRequest, "acme/api#1", "the merge request opened during the stop")
  assert.equal(inbox.deliverables.at(-1)!.error, "")
  assert.ok(inbox.states.filter((s) => s.state === "closed").every((s) => !s.isError))
  assert.deepEqual(workspace.removed, ["job-1"])
  assert.equal(table.has("job-1"), false)
})

test("a stop during the wrap-up turn waits for its finish and its delivery before the drain returns", async () => {
  const workspace = fakeWorkspace({ wrapDelayMs: 120 })
  const { m, inbox, table, rec } = member({ workspace })
  inbox.queued.push(input("job-1", { spec: repoSpec("job-1") }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  await inbox.deliver({ jobId: "job-1", kind: "wrap_up", text: "verified", grant: "wrap-grant", sender: "component:agent:verifier", verdict: "accomplished", score: 95 })
  await settle()
  assert.equal(rec.calls.length, 2, "the wrap-up turn is running")
  ac.abort()
  rec.finish[1]!()
  await run
  assert.deepEqual(workspace.wrapped, ["job-1"], "the delivery ran before the drain returned")
  assert.deepEqual(workspace.removed, ["job-1"])
  assert.equal(table.has("job-1"), false)
  assert.equal(inbox.deliverables.length, 1)
})

test("a waiting delivery does not block the pump: another job runs on a free slot", async () => {
  const workspace = fakeWorkspace({
    outcomes: [[{ mergeRequest: "", mergeRequestUrl: "", error: "busy", failed: true, retryable: true }]],
  })
  const { m, inbox, table, rec } = member({ workspace, deliverRetryMs: 600_000, deliverBackoffMs: 600_000 }, 2)
  inbox.queued.push(input("job-1", { spec: repoSpec("job-1") }))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  await inbox.deliver({ jobId: "job-1", kind: "close", text: "", grant: "g", sender: "s", verdict: "accomplished", score: 95 })
  await settle()
  inbox.queued.push(input("job-2"))
  await settle()
  assert.equal(table.get("job-2").state, "working", "the second job started while the first waits to deliver")
  assert.equal(m.status().jobsInFlight, 2)
  ac.abort()
  rec.finish[1]!()
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
  const { m, inbox, rec } = member({ mcp: { url: "http://127.0.0.1:7455/mcp", useGrant: async (j: string, g: string) => void grants.push([j, g]), release: async () => {}, answer: async () => false } })
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

/** A sign-in attempt that records what the member asked of it. */
function fakeSignIn() {
  const attempts: { started: number; codes: string[]; cancelled: number; end: (ok: boolean) => void }[] = []
  const factory = (): SignInAttempt => {
    let end!: (ok: boolean) => void
    const done = new Promise<boolean>((r) => (end = r))
    const a = { started: 0, codes: [] as string[], cancelled: 0, end }
    attempts.push(a)
    return {
      done,
      start: async () => {
        a.started++
      },
      submitCode: (code: string) => {
        a.codes.push(code)
      },
      cancel: () => {
        a.cancelled++
        end(false)
      },
    }
  }
  return { attempts, factory }
}

const signInInput = (kind: JobInput["kind"], text: string): JobInput => input(SIGN_IN_JOB_ID, { kind, text, grant: "", spec: undefined })

test("a start control input starts one sign-in, and the pasted code reaches it, not a job", async () => {
  const signIn = fakeSignIn()
  const logs: string[] = []
  const { m, inbox, rec } = member({ signIn: signIn.factory, log: (l) => logs.push(l) })
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle(2)
  await inbox.deliver(signInInput("turn", SIGN_IN_START))
  await inbox.deliver(signInInput("turn", SIGN_IN_START))
  await settle(2)
  assert.equal(signIn.attempts.length, 1, "a second start while one runs starts nothing")
  assert.equal(signIn.attempts[0]!.started, 1)
  await inbox.deliver(signInInput("answer", "code-123"))
  await settle(2)
  assert.deepEqual(signIn.attempts[0]!.codes, ["code-123"])
  assert.equal(rec.calls.length, 0, "a control input runs no turn")
  assert.equal(inbox.states.length, 0, "a control input opens no job")
  assert.ok(!logs.some((l) => l.includes("code-123")), "the code is never logged")

  signIn.attempts[0]!.end(true)
  await settle(2)
  await inbox.deliver(signInInput("turn", SIGN_IN_START))
  await settle(2)
  assert.equal(signIn.attempts.length, 2, "a finished sign-in lets the next start run")
  ac.abort()
  await run
  assert.equal(signIn.attempts[1]!.cancelled, 1, "a stop cancels the sign-in that runs")
})

test("a code with no sign-in running is dropped, and a member with no sign-in ignores the relay", async () => {
  const logs: string[] = []
  const signIn = fakeSignIn()
  const { m, inbox } = member({ signIn: signIn.factory, log: (l) => logs.push(l) })
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle(2)
  await inbox.deliver(signInInput("answer", "code-9"))
  await settle(2)
  assert.ok(logs.some((l) => l.includes("no sign-in is waiting for a code")))
  assert.ok(!logs.some((l) => l.includes("code-9")), "the code is never logged")
  ac.abort()
  await run

  const plain = member({ log: (l) => logs.push(l) })
  const ac2 = new AbortController()
  const run2 = plain.m.run(ac2.signal)
  await settle(2)
  await plain.inbox.deliver(signInInput("turn", SIGN_IN_START))
  await settle(2)
  assert.ok(logs.some((l) => l.includes("takes no sign-in")))
  assert.equal(plain.inbox.states.length, 0)
  ac2.abort()
  await run2
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

/** Timers whose sleeps are short but whose requested lengths are recorded, so a backoff is testable. */
function fastTimers(): { timers: MemberDeps["timers"]; sleeps: number[] } {
  const sleeps: number[] = []
  const timers: MemberDeps["timers"] = {
    setTimeout: ((fn: () => void, ms: number) => {
      sleeps.push(ms)
      return setTimeout(fn, Math.min(ms, 5))
    }) as typeof setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  return { timers, sleeps }
}

test("a heartbeat the daemon refuses is logged once, carried as degraded, and the member keeps heartbeating", async () => {
  const requests: { healthStatus: string; healthMessage: string }[] = []
  let refusals = 0
  const component = {
    heartbeat: async (r: { healthStatus: string; healthMessage: string }) => {
      requests.push({ healthStatus: r.healthStatus, healthMessage: r.healthMessage })
      if (refusals < 3) {
        refusals += 1
        throw new ConnectError("context.mission_run_id is required to identify the calling member", Code.InvalidArgument)
      }
      return {}
    },
  } as never
  const lines: string[] = []
  const { m, rec } = member({
    status: new ComponentHeartbeat({ component, instanceId: "mem-1" }),
    env: memberEnv({ ZEROCOOL_HEARTBEAT_MS: "10" }),
    log: (l) => lines.push(l),
  })
  const ac = new AbortController()
  const run = m.run(ac.signal)
  try {
    await settle(8)
    assert.ok(requests.length >= 6, `the member kept heartbeating through the refusals: ${requests.length} requests`)
    assert.equal(refusals, 3)
    assert.equal(requests[0]!.healthStatus, "healthy")
    assert.equal(requests[3]!.healthStatus, "degraded", "the first heartbeat after a refusal carries it")
    assert.match(requests[3]!.healthMessage, /last error: heartbeat: \[invalid_argument\] context\.mission_run_id is required/)
    assert.equal(requests[4]!.healthStatus, "healthy", "the failure clears once the heartbeat lands")
    assert.equal(m.status().lastError, "")
    const heartbeatLines = lines.filter((l) => l.startsWith("heartbeat:"))
    assert.ok(heartbeatLines.length <= 3, `at most three lines for three identical refusals: ${JSON.stringify(heartbeatLines)}`)
    assert.deepEqual(heartbeatLines, [
      "heartbeat: [invalid_argument] context.mission_run_id is required to identify the calling member; the member keeps running",
      "heartbeat: recovered",
    ])
  } finally {
    ac.abort()
    await run
  }
  assert.equal(rec.calls.length, 0)
})

test("a pull the daemon refuses backs off like the inbox, and the member runs the job once the pull lands", async () => {
  const { timers, sleeps } = fastTimers()
  const lines: string[] = []
  const { m, inbox, rec } = member({ timers, log: (l) => lines.push(l) })
  let refusals = 0
  const pull = inbox.pull.bind(inbox)
  inbox.pull = async () => {
    if (refusals < 3) {
      refusals += 1
      throw new ConnectError("context.mission_run_id is required to identify the calling member", Code.InvalidArgument)
    }
    return pull()
  }
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  try {
    await settle(8)
    assert.equal(refusals, 3)
    assert.deepEqual(sleeps.slice(0, 3), [500, 1000, 2000], "the inbox backoff shape, doubling from 500 ms")
    assert.equal(rec.calls.length, 1, "the job ran once the pull landed")
    assert.ok(sleeps.slice(3).every((ms) => ms === 5), "after the pull lands the loop is back on the idle poll")
    assert.deepEqual(
      lines.filter((l) => l.startsWith("pull:")),
      ["pull: [invalid_argument] context.mission_run_id is required to identify the calling member; the member keeps running", "pull: recovered"],
    )
  } finally {
    ac.abort()
    rec.finish[0]?.()
    await run
  }
})

test("a failure in the loop body is survived too, and run resolves only on stop", async () => {
  const { timers, sleeps } = fastTimers()
  const lines: string[] = []
  const { m, table, rec } = member({ timers, log: (l) => lines.push(l) })
  let refusals = 0
  const abandonStale = table.abandonStale.bind(table)
  table.abandonStale = async (ms: number) => {
    if (refusals < 2) {
      refusals += 1
      throw new Error("store unavailable")
    }
    return abandonStale(ms)
  }
  const ac = new AbortController()
  const run = m.run(ac.signal)
  try {
    await settle(6)
    assert.equal(refusals, 2)
    assert.deepEqual(sleeps.slice(0, 2), [500, 1000], "a loop failure backs off the same way")
    assert.equal(m.status().state, "idle", "still alive")
    assert.deepEqual(lines.filter((l) => l.startsWith("loop:")), ["loop: store unavailable; the member keeps running", "loop: recovered"])
  } finally {
    ac.abort()
    await run
  }
  assert.equal(rec.calls.length, 0)
})

test("an answer goes to the open question on the MCP server and does not start a turn", async () => {
  const answers: [string, string, string][] = []
  const { m, inbox, rec } = member({
    mcp: { url: "http://127.0.0.1:7455/mcp", useGrant: async () => {}, release: async () => {}, answer: async (j: string, t: string, s: string) => (answers.push([j, t, s]), true) },
  })
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  await inbox.deliver(input("job-1", { kind: "answer", text: "use the second approach", spec: undefined }))
  await settle()
  assert.deepEqual(answers, [["job-1", "use the second approach", "user:ana"]])
  assert.equal(rec.finish.length, 1, "the answer is not a second turn")
  ac.abort()
  rec.finish[0]!()
  await run
})

test("an answer with no open question runs as a turn: a person's reply is never dropped", async () => {
  const { m, inbox, rec } = member({
    mcp: { url: "http://127.0.0.1:7455/mcp", useGrant: async () => {}, release: async () => {}, answer: async () => false },
  })
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  rec.finish[0]!()
  await settle()
  await inbox.deliver(input("job-1", { kind: "answer", text: "late reply", spec: undefined }))
  await settle()
  assert.equal(rec.finish.length, 2, "the reply started the next turn")
  ac.abort()
  rec.finish[1]!()
  await run
})

test("a member that has not signed in pulls no job and starts no turn, and takes work once it has", async () => {
  let signedIn = false
  const { m, inbox, rec } = member({ needsSignIn: () => !signedIn })
  inbox.queued.push(input("job-1"))
  const ac = new AbortController()
  const run = m.run(ac.signal)
  await settle()
  assert.equal(inbox.queued.length, 1, "the job stays in the daemon's queue: pulling it would run a turn with no login")
  assert.equal(rec.calls.length, 0)
  signedIn = true
  await settle()
  assert.equal(inbox.queued.length, 0)
  assert.equal(rec.calls.length, 1, "the same member works the job after the sign-in")
  ac.abort()
  rec.finish[0]!()
  await run
})
