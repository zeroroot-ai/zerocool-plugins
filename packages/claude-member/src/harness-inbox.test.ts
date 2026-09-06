// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import type { TaskHarness } from "@zeroroot-ai/sdk"
import { DeliverableKind, InputKind, JobState as WireJobState } from "@zeroroot-ai/sdk/gen/gibson/job/v1/job_pb.js"
import { Principal_Kind } from "@zeroroot-ai/sdk/gen/gibson/common/v1/gibson_common_pb.js"
import { HarnessInbox, harnessGrants, inputKindOf, jobInputOf, nextBackoff, openInputOf, repositoryOf, senderOf, wireJobState, MAX_BACKOFF_MS, MIN_BACKOFF_MS } from "./harness-inbox.js"

const spec = {
  credentialFor: (ref: string) => `${ref.split("/").pop()}-connector-cred`,
  baseUrlFor: () => "https://git.example",
}

function wireInput() {
  return {
    $typeName: "gibson.job.v1.Input",
    jobId: "job-1",
    message: "the verifier failed on pass one",
    sender: { $typeName: "gibson.common.v1.Principal", kind: Principal_Kind.COMPONENT, id: "verifier" },
    grant: "turn-grant",
    kind: InputKind.TURN,
    id: "in-1",
  } as never
}

function wireJob(over: Record<string, unknown> = {}) {
  return {
    $typeName: "gibson.job.v1.Job",
    id: "job-9",
    bankId: "bank-1",
    memberId: "mem-1",
    state: WireJobState.OPEN,
    claudeSessionId: "",
    openedBy: { $typeName: "gibson.common.v1.Principal", kind: Principal_Kind.USER, id: "ana" },
    spec: {
      $typeName: "gibson.job.v1.JobSpec",
      goal: "close the unauthenticated route",
      repositories: [
        { $typeName: "gibson.job.v1.RepositorySpec", name: "api", connectorRef: "gitlab/acme", project: "acme/api", baseBranch: "develop", deliverable: DeliverableKind.MERGE_REQUEST },
      ],
      credentialNames: ["sonar-token"],
      inputs: ["node-1"],
      acceptance: { $typeName: "gibson.job.v1.Acceptance", verifierComponent: "component:agent:verifier", passingScore: 80, maxPasses: 3 },
      context: {},
    },
    ...over,
  } as never
}

test("every input kind maps, and an unset kind is a turn rather than a dropped message", () => {
  assert.equal(inputKindOf(InputKind.TURN), "turn")
  assert.equal(inputKindOf(InputKind.ANSWER), "answer")
  assert.equal(inputKindOf(InputKind.WRAP_UP), "wrap_up")
  assert.equal(inputKindOf(InputKind.UNSPECIFIED), "turn")
})

test("a job state maps to the wire enum", () => {
  assert.equal(wireJobState("open"), WireJobState.OPEN)
  assert.equal(wireJobState("working"), WireJobState.WORKING)
  assert.equal(wireJobState("waiting"), WireJobState.WAITING)
  assert.equal(wireJobState("closed"), WireJobState.CLOSED)
})

test("a sender reads as one line, and a missing one is not a crash", () => {
  assert.equal(senderOf({ $typeName: "gibson.common.v1.Principal", kind: Principal_Kind.USER, id: "ana" } as never), "user:ana")
  assert.equal(senderOf(undefined), "unknown")
})

test("an input carries its own grant, which is the whole point of the per-turn rule", () => {
  const input = jobInputOf(wireInput())
  assert.equal(input.jobId, "job-1")
  assert.equal(input.kind, "turn")
  assert.equal(input.text, "the verifier failed on pass one")
  assert.equal(input.grant, "turn-grant")
  assert.equal(input.sender, "component:verifier")
})

test("a repository named by project gets its clone url from the connector base url", () => {
  const repo = repositoryOf(
    { $typeName: "gibson.job.v1.RepositorySpec", name: "", connectorRef: "gitlab/acme", project: "acme/api", baseBranch: "", deliverable: DeliverableKind.PUSH_BRANCH } as never,
    "acme-connector-cred",
    "https://git.example/",
  )
  assert.equal(repo.cloneUrl, "https://git.example/acme/api.git")
  assert.equal(repo.name, "api", "an unnamed repository takes the project's last element")
  assert.equal(repo.baseBranch, "main", "an unset base branch is main")
  assert.equal(repo.deliverable, "PUSH_BRANCH")
  assert.equal(repo.credentialName, "acme-connector-cred")
})

test("a repository named by url keeps it", () => {
  const repo = repositoryOf(
    { $typeName: "gibson.job.v1.RepositorySpec", name: "api", connectorRef: "gitlab/acme", project: "https://git.example/acme/api.git", baseBranch: "main", deliverable: DeliverableKind.NONE } as never,
    "cred",
    "https://ignored",
  )
  assert.equal(repo.cloneUrl, "https://git.example/acme/api.git")
})

test("a pulled job becomes the open input that starts it, under the base grant", () => {
  const input = openInputOf(wireJob(), "base-grant", spec)
  assert.equal(input.kind, "open")
  assert.equal(input.jobId, "job-9")
  assert.equal(input.grant, "base-grant", "a queued job carries no per-input grant")
  assert.equal(input.sender, "user:ana")
  assert.equal(input.spec?.goal, "close the unauthenticated route")
  assert.equal(input.spec?.repositories[0]?.cloneUrl, "https://git.example/acme/api.git")
  assert.equal(input.spec?.repositories[0]?.credentialName, "acme-connector-cred")
  assert.deepEqual(input.spec?.credentialNames, ["sonar-token"])
  assert.deepEqual(input.spec?.inputNodeIds, ["node-1"])
  assert.match(input.spec?.acceptance ?? "", /component:agent:verifier must score at least 80/)
})

test("a job with no spec is still a job, not a crash", () => {
  const input = openInputOf(wireJob({ spec: undefined }), "g", spec)
  assert.equal(input.spec?.goal, "")
  assert.deepEqual(input.spec?.repositories, [])
})

/** A harness whose client records calls and answers from a script. */
function fakeHarness(over: Record<string, unknown> = {}): TaskHarness & { calls: { rpc: string; req: unknown }[] } {
  const calls: { rpc: string; req: unknown }[] = []
  const client = {
    subscribeInput: (req: unknown) => {
      calls.push({ rpc: "subscribeInput", req })
      return (over.subscribeInput as () => AsyncIterable<unknown>)()
    },
    pullJob: async (req: unknown) => {
      calls.push({ rpc: "pullJob", req })
      return (over.pullJob as unknown) ?? { job: undefined }
    },
    reportJobState: async (req: unknown) => {
      calls.push({ rpc: "reportJobState", req })
      return (over.reportJobState as unknown) ?? {}
    },
    reportDeliverable: async (req: unknown) => {
      calls.push({ rpc: "reportDeliverable", req })
      return (over.reportDeliverable as unknown) ?? {}
    },
  }
  return {
    client: client as never,
    transport: undefined as never,
    endpoint: "gibson:50001",
    context: { missionId: "m-1", taskId: "t-1", agentName: "claude" } as never,
    token: () => "base-grant",
    expiresAt: () => 0,
    stop: () => {},
    calls,
  }
}

test("the subscription forwards every input, in order", async () => {
  const harness = fakeHarness({
    subscribeInput: async function* () {
      yield { input: wireInput() }
      yield { input: undefined }
      yield { input: { ...(wireInput() as object), jobId: "job-2", kind: InputKind.ANSWER } }
    },
  })
  const inbox = new HarnessInbox({ harness, memberId: "mem-1", spec, sleep: async () => {} })
  const seen: string[] = []
  const ac = new AbortController()
  const run = inbox.subscribe(async (i) => {
    seen.push(`${i.jobId}:${i.kind}`)
    if (seen.length === 2) ac.abort()
  }, ac.signal)
  await run
  assert.deepEqual(seen, ["job-1:turn", "job-2:answer"])
  assert.equal((harness.calls[0]!.req as { context: unknown }).context !== undefined, true, "every call carries the context the grant implies")
})

test("a dropped subscription reconnects with backoff instead of killing the member", async () => {
  let attempts = 0
  const ac = new AbortController()
  const harness = fakeHarness({
    subscribeInput: async function* () {
      attempts += 1
      if (attempts < 3) throw new Error("stream closed")
      yield { input: wireInput() }
      ac.abort()
    },
  })
  const delays: number[] = []
  const inbox = new HarnessInbox({ harness, memberId: "mem-1", spec, sleep: async (ms) => void delays.push(ms) })
  await inbox.subscribe(async () => {}, ac.signal)
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [MIN_BACKOFF_MS, MIN_BACKOFF_MS * 2])
})

test("the backoff doubles to a cap", () => {
  assert.equal(nextBackoff(0), MIN_BACKOFF_MS)
  assert.equal(nextBackoff(MIN_BACKOFF_MS), MIN_BACKOFF_MS * 2)
  assert.equal(nextBackoff(MAX_BACKOFF_MS), MAX_BACKOFF_MS)
})

test("pull returns nothing on an empty queue and raises a refusal", async () => {
  const empty = new HarnessInbox({ harness: fakeHarness(), memberId: "mem-1", spec })
  assert.equal(await empty.pull(), undefined)

  const refused = new HarnessInbox({ harness: fakeHarness({ pullJob: { error: { message: "not a member of that bank" } } }), memberId: "mem-1", spec })
  await assert.rejects(refused.pull(), /PullJob refused: not a member of that bank/)
})

test("pull maps the queued job into the open input", async () => {
  const inbox = new HarnessInbox({ harness: fakeHarness({ pullJob: { job: wireJob() } }), memberId: "mem-1", spec })
  const input = await inbox.pull()
  assert.equal(input?.jobId, "job-9")
  assert.equal(input?.kind, "open")
})

test("a state report names the job, the wire state and the Claude session", async () => {
  const harness = fakeHarness()
  const inbox = new HarnessInbox({ harness, memberId: "mem-1", spec })
  await inbox.reportState({ jobId: "job-1", state: "waiting", claudeSessionId: "sess-1", turns: 2, costUsd: 1, isError: false, detail: "done" })
  const req = harness.calls[0]!.req as { jobId: string; state: number; claudeSessionId: string }
  assert.equal(req.jobId, "job-1")
  assert.equal(req.state, WireJobState.WAITING)
  assert.equal(req.claudeSessionId, "sess-1")
})

test("a deliverable report carries the kind, the branch and the merge request url", async () => {
  const harness = fakeHarness()
  const inbox = new HarnessInbox({ harness, memberId: "mem-1", spec })
  await inbox.reportDeliverable({ jobId: "job-1", repository: "api", deliverable: "MERGE_REQUEST", branch: "job/job-1", commits: 2, mergeRequestUrl: "https://git.example/mr/1", error: "" })
  const req = harness.calls[0]!.req as { deliverable: { kind: number; ref: string; url: string } }
  assert.equal(req.deliverable.kind, DeliverableKind.MERGE_REQUEST)
  assert.equal(req.deliverable.ref, "job/job-1")
  assert.equal(req.deliverable.url, "https://git.example/mr/1")
})

test("a refused report is raised, never swallowed", async () => {
  const inbox = new HarnessInbox({ harness: fakeHarness({ reportJobState: { error: { message: "no such job" } } }), memberId: "mem-1", spec })
  await assert.rejects(inbox.reportState({ jobId: "job-1", state: "working", claudeSessionId: "", turns: 0, costUsd: 0, isError: false, detail: "" }), /ReportJobState\(job-1\) refused: no such job/)
})

test("the grants come from the harness, so a renewal takes effect on the next turn", () => {
  let token = "grant-1"
  const harness = { ...fakeHarness(), token: () => token }
  const grants = harnessGrants(harness)
  assert.equal(grants.baseGrant(), "grant-1")
  token = "grant-2"
  assert.equal(grants.baseGrant(), "grant-2", "a member runs for days; the harness renews under it")
  assert.equal(grants.grantFor({ jobId: "j", kind: "turn", text: "", grant: "turn-grant", sender: "user:ana" }), "turn-grant")
  assert.equal(grants.grantFor({ jobId: "j", kind: "open", text: "", grant: "", sender: "user:ana" }), "grant-2", "an input with no grant of its own runs on the base grant")
})
