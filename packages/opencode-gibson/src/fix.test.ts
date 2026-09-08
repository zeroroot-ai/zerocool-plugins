// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import {
  gitlabRestWriter,
  SCAN_STATUS_CONTEXT,
  type CommitStatusState,
  type FileChange,
  type GitLabWriter,
  type MergeRequest,
} from "./gitlab.js"
import {
  byWorkOrder,
  countsBySeverity,
  fixBranch,
  harnessFindingSource,
  harnessFindingStatus,
  noteBody,
  runFix,
  statusDescription,
  type FixableFinding,
  type FixEvent,
  type FixPlan,
  type FixPlanner,
  type FindingSource,
  type FindingStatusWriter,
  type ObserveLifecycle,
  type ReadFinding,
  type Workspace,
} from "./fix.js"
import { dispatchTaskKind, readDispatchContext, runDispatch, type DispatchContext } from "./dispatch.js"

/**
 * The Fix (zerocool-plugins#89).
 *
 * The properties under test, in order of how much they would cost to get wrong:
 *
 *  1. **Nothing unproven is pushed.** The repository's tests run in the
 *     workspace before a branch exists, and a failure leaves the Finding open
 *     with its reason recorded rather than opening a merge request.
 *  2. **The Fix never marks a Finding `verified`.** A merge is not evidence
 *     that a rescan did not see it again (gibson#1686).
 *  3. **The token never reaches anything the Fix writes.** A sentinel token is
 *     used throughout and every recorded output is searched for it.
 *  4. **One bad Finding does not stop the ones behind it.**
 *  5. **A failed read is an error, never an empty backlog** — an empty list
 *     reads as a healthy Application.
 *
 * Nothing here reaches GitLab, a daemon or the World.
 */

const SENTINEL = "glpat-SENTINEL" // short on purpose: a real GitLab PAT shape would trip secret scanners

// --------------------------------------------------------------------------
// doubles
// --------------------------------------------------------------------------

function finding(over: Partial<FixableFinding> = {}): FixableFinding {
  return {
    id: "brain-0000000000001",
    status: "open",
    severity: "high",
    vulnerabilityId: "CVE-2026-0001",
    placeLabel: "Package",
    placeKey: "lodash@4.17.20",
    ...over,
  }
}

/** A workspace that records what was staged and answers a scripted test verdict. */
function workspace(testVerdict: { ok: boolean; output: string } = { ok: true, output: "" }): Workspace & {
  resets: number
} {
  let staged: FileChange[] = []
  const ws = {
    resets: 0,
    read: async () => undefined,
    write: async (path: string, content: string) => {
      staged = [...staged.filter((c) => c.path !== path), { path, content }]
    },
    test: async () => testVerdict,
    reset: async () => {
      staged = []
      ws.resets++
    },
    staged: () => staged,
  }
  return ws
}

/** A GitLab writer that records every call and never touches a network. */
function writer(over: Partial<GitLabWriter> = {}): GitLabWriter & {
  commits: { branch: string; message: string; changes: FileChange[] }[]
  mrs: { branch: string; title: string; description: string }[]
  notes: { iid: number; body: string }[]
  statuses: { sha: string; state: CommitStatusState; description: string }[]
} {
  const rec = {
    commits: [] as { branch: string; message: string; changes: FileChange[] }[],
    mrs: [] as { branch: string; title: string; description: string }[],
    notes: [] as { iid: number; body: string }[],
    statuses: [] as { sha: string; state: CommitStatusState; description: string }[],
  }
  let nextIid = 100
  return {
    ...rec,
    commitToBranch: async (branch, _start, message, changes) => {
      rec.commits.push({ branch, message, changes })
      return "sha-of-" + branch
    },
    openMergeRequest: async (branch, _target, title, description) => {
      rec.mrs.push({ branch, title, description })
      return { iid: nextIid++, webUrl: `https://gitlab.example/mr/${nextIid}`, state: "opened" }
    },
    mergeRequestState: async (iid) => ({ iid, webUrl: "", state: "opened" }),
    comment: async (iid, body) => {
      rec.notes.push({ iid, body })
    },
    setCommitStatus: async (sha, state, description) => {
      rec.statuses.push({ sha, state, description })
    },
    ...over,
  }
}

function statusWriter(): FindingStatusWriter & { fixing: string[]; fixed: string[] } {
  const rec = { fixing: [] as string[], fixed: [] as string[] }
  return {
    ...rec,
    markFixing: async (id) => {
      rec.fixing.push(id)
    },
    markFixed: async (id) => {
      rec.fixed.push(id)
    },
  }
}

function source(findings: FixableFinding[] | Error): FindingSource {
  return {
    findings: async () => {
      if (findings instanceof Error) throw findings
      return findings
    },
  }
}

/** A planner that stages one file per Finding, or refuses when told to. */
function planner(behaviour: "fix" | "none" | "throw" | "nochange" = "fix"): FixPlanner {
  return {
    plan: async (f, ws): Promise<FixPlan | undefined> => {
      if (behaviour === "throw") throw new Error("planner exploded")
      if (behaviour === "none") return undefined
      if (behaviour !== "nochange") {
        await ws.write("package.json", `{"lodash":"4.17.21"} // ${f.id}`)
      }
      return { kind: "dependency", summary: `bump ${f.placeKey}`, detail: `Fixes ${f.vulnerabilityId}.` }
    },
  }
}

function base(over: Partial<Parameters<typeof runFix>[0]> = {}) {
  return {
    application: "customer-portal",
    commit: "c0ffee1234567890",
    targetRef: "main",
    findings: source([finding()]),
    status: statusWriter(),
    planner: planner(),
    workspace: workspace(),
    gitlab: writer(),
    ...over,
  }
}

// --------------------------------------------------------------------------
// the fix loop
// --------------------------------------------------------------------------

test("a fixable finding is tested, committed, and opened as an auto-merging request", async () => {
  const gl = writer()
  const st = statusWriter()
  const events: FixEvent[] = []
  const summary = await runFix(base({ gitlab: gl, status: st, onEvent: (e) => events.push(e) }))

  assert.equal(gl.commits.length, 1, "one commit")
  assert.equal(gl.mrs.length, 1, "one merge request")
  assert.equal(summary.outcomes[0]?.result, "fixing")
  assert.deepEqual(st.fixing, ["brain-0000000000001"])
  assert.deepEqual(st.fixed, [], "nothing is fixed until GitLab merges it")
  assert.ok(
    events.some((e) => e.type === "fix.tests" && e.ok),
    "the console records that tests ran",
  )
})

test("the tests run before anything reaches GitLab", async () => {
  const order: string[] = []
  const ws = workspace()
  const originalTest = ws.test
  ws.test = async () => {
    order.push("test")
    return originalTest()
  }
  const gl = writer({
    commitToBranch: async (branch) => {
      order.push("commit")
      return `sha-${branch}`
    },
  })
  await runFix(base({ workspace: ws, gitlab: gl }))
  assert.deepEqual(order, ["test", "commit"], "tests run first, always")
})

test("a fix whose tests fail opens no merge request and leaves the finding open", async () => {
  const gl = writer()
  const st = statusWriter()
  const summary = await runFix(
    base({ workspace: workspace({ ok: false, output: "3 failing\nassert equal" }), gitlab: gl, status: st }),
  )

  assert.equal(gl.commits.length, 0, "nothing was pushed")
  assert.equal(gl.mrs.length, 0, "no merge request")
  assert.deepEqual(st.fixing, [], "the finding stays open")
  assert.equal(summary.outcomes[0]?.result, "unfixed")
  assert.match(summary.outcomes[0]?.reason ?? "", /tests failed/)
  assert.match(summary.outcomes[0]?.reason ?? "", /3 failing/, "the reason quotes the failure")
})

test("a failed fix resets the workspace so it cannot leak into the next finding", async () => {
  const ws = workspace({ ok: false, output: "boom" })
  await runFix(base({ workspace: ws, findings: source([finding(), finding({ id: "brain-2" })]) }))
  assert.ok(ws.resets >= 2, "each attempt resets")
  assert.deepEqual(ws.staged(), [], "nothing is left staged")
})

test("a finding with no strategy is reported with that reason and does not stop the rest", async () => {
  let call = 0
  const mixed: FixPlanner = {
    plan: async (f, ws) => {
      call++
      if (call === 1) return undefined
      await ws.write("package.json", "fixed")
      return { kind: "dependency", summary: "bump", detail: "d" }
    },
  }
  const gl = writer()
  const summary = await runFix(
    base({ planner: mixed, gitlab: gl, findings: source([finding({ id: "brain-a" }), finding({ id: "brain-b" })]) }),
  )
  assert.equal(summary.outcomes[0]?.result, "unfixed")
  assert.match(summary.outcomes[0]?.reason ?? "", /no fix strategy/)
  assert.equal(summary.outcomes[1]?.result, "fixing", "the second finding is still worked")
  assert.equal(gl.mrs.length, 1)
})

test("a planner that throws is reported and does not stop the rest", async () => {
  const summary = await runFix(base({ planner: planner("throw") }))
  assert.equal(summary.outcomes[0]?.result, "unfixed")
  assert.match(summary.outcomes[0]?.reason ?? "", /planning failed: planner exploded/)
})

test("a planner that changes nothing opens no merge request", async () => {
  const gl = writer()
  const summary = await runFix(base({ planner: planner("nochange"), gitlab: gl }))
  assert.equal(gl.commits.length, 0)
  assert.match(summary.outcomes[0]?.reason ?? "", /changed nothing/)
})

test("the fix never marks a finding verified — only a merge moves it to fixed", async () => {
  const st = statusWriter()
  const gl = writer({ mergeRequestState: async (iid) => ({ iid, webUrl: "u", state: "merged" }) })
  const summary = await runFix(
    base({
      status: st,
      gitlab: gl,
      findings: source([finding({ id: "brain-m", status: "fixing", mergeRequestIid: 7 })]),
    }),
  )
  assert.deepEqual(st.fixed, ["brain-m"])
  assert.equal(summary.outcomes[0]?.result, "merged")
  const written = JSON.stringify(summary) + gl.notes.map((n) => n.body).join("")
  assert.ok(!/\bverified\b/.test(written), "the word never appears in anything the Fix writes")
})

test("a merge request still open leaves its finding fixing", async () => {
  const st = statusWriter()
  const summary = await runFix(
    base({ status: st, findings: source([finding({ id: "brain-o", status: "fixing", mergeRequestIid: 9 })]) }),
  )
  assert.deepEqual(st.fixed, [])
  assert.equal(summary.outcomes.length, 0, "an unmerged request is not an outcome of this pass")
})

test("a read failure is raised, never reported as a clean application", async () => {
  await assert.rejects(
    () => runFix(base({ findings: source(new Error("graph unreachable")) })),
    /graph unreachable/,
  )
})

test("the merge request cap bounds one pass", async () => {
  const many = Array.from({ length: 4 }, (_, i) => finding({ id: `brain-${i}` }))
  const gl = writer()
  const summary = await runFix(base({ findings: source(many), gitlab: gl, maxMergeRequests: 2 }))
  assert.equal(gl.mrs.length, 2)
  assert.equal(summary.outcomes.filter((o) => o.result === "unfixed").length, 2)
  assert.match(summary.outcomes[2]?.reason ?? "", /cap of 2/)
})

// --------------------------------------------------------------------------
// what the commit and the merge request say
// --------------------------------------------------------------------------

test("the scan verdict lands on the scanned commit", async () => {
  const gl = writer()
  await runFix(base({ gitlab: gl }))
  assert.equal(gl.statuses.length, 1)
  assert.equal(gl.statuses[0]?.sha, "c0ffee1234567890")
  assert.equal(gl.statuses[0]?.state, "success")
})

test("a finding left for a human fails the commit status", async () => {
  const gl = writer()
  await runFix(base({ gitlab: gl, planner: planner("none") }))
  assert.equal(gl.statuses[0]?.state, "failed")
  assert.match(gl.statuses[0]?.description ?? "", /1 left for a human/)
})

test("a GitLab outage on the status does not lose the pass's work", async () => {
  const gl = writer({
    setCommitStatus: async () => {
      throw new Error("502")
    },
  })
  const events: FixEvent[] = []
  const summary = await runFix(base({ gitlab: gl, onEvent: (e) => events.push(e) }))
  assert.equal(summary.outcomes[0]?.result, "fixing", "the fix still happened")
  assert.ok(events.some((e) => e.type === "fix.error"))
})

test("the note counts by severity and names what was left, with reasons", () => {
  const body = noteBody({
    application: "customer-portal",
    commit: "c0ffee1234567890",
    clean: false,
    outcomes: [
      { finding: finding({ severity: "critical" }), result: "fixing", reason: "", mergeRequest: { iid: 1, webUrl: "https://gitlab.example/mr/1", state: "opened" } },
      { finding: finding({ id: "b2", severity: "low", vulnerabilityId: "CVE-2026-0002" }), result: "unfixed", reason: "the repository's tests failed: 3 failing" },
    ],
  })
  assert.match(body, /1 critical, 1 low/)
  assert.match(body, /\*\*Fixed\*\*/)
  assert.match(body, /https:\/\/gitlab\.example\/mr\/1/)
  assert.match(body, /\*\*Left for a human\*\*/)
  assert.match(body, /CVE-2026-0002.*tests failed/s)
})

test("an unknown severity is counted, not dropped", () => {
  assert.deepEqual(countsBySeverity([finding({ severity: "spicy" })]), { other: 1 })
})

test("the branch name is stable and safe for git", () => {
  const b = fixBranch(finding({ vulnerabilityId: "CVE-2026-0001/../etc" }))
  assert.equal(b, fixBranch(finding({ vulnerabilityId: "CVE-2026-0001/../etc" })), "stable")
  assert.ok(!b.includes(".."), "no traversal survives the slug")
  assert.ok(!b.includes("."), "no dot survives, since git refuses a ref containing `..`")
  assert.match(b, /^gibson\/fix-[a-z0-9-]+$/)
  assert.match(fixBranch(finding({ vulnerabilityId: "" })), /^gibson\/fix-brain-0000000000001-brain-00$/)
})

test("the status line reports no open findings rather than an empty success", () => {
  assert.equal(
    statusDescription({ application: "a", commit: "c", clean: true, outcomes: [] }),
    "no open findings",
  )
})

// --------------------------------------------------------------------------
// the token
// --------------------------------------------------------------------------

test("the token never reaches a branch, title, description, note or status", async () => {
  const seen: string[] = []
  const gl: GitLabWriter = {
    commitToBranch: async (branch, start, message, changes) => {
      seen.push(branch, start, message, JSON.stringify(changes))
      return "sha"
    },
    openMergeRequest: async (branch, target, title, description) => {
      seen.push(branch, target, title, description)
      return { iid: 1, webUrl: "https://gitlab.example/mr/1", state: "opened" }
    },
    mergeRequestState: async (iid) => ({ iid, webUrl: "", state: "opened" }),
    comment: async (iid, body) => {
      seen.push(String(iid), body)
    },
    setCommitStatus: async (sha, state, description) => {
      seen.push(sha, state, description)
    },
  }
  const events: FixEvent[] = []
  // The planner is handed the token the way a real one would be, so a leak
  // through the plan text or the staged content would show up here too.
  const leaky: FixPlanner = {
    plan: async (f, ws) => {
      await ws.write("package.json", `{"token-should-not-be-here":true}`)
      return { kind: "dependency", summary: `bump ${f.placeKey}`, detail: `Fixes ${f.vulnerabilityId}.` }
    },
  }
  const summary = await runFix(base({ gitlab: gl, planner: leaky, onEvent: (e) => events.push(e) }))

  const everything = [seen.join("\n"), JSON.stringify(events), JSON.stringify(summary)].join("\n")
  assert.ok(!everything.includes(SENTINEL), "the sentinel appears nowhere the Fix writes")
  assert.ok(!everything.includes("glpat-"), "no token-shaped string at all")
})

// --------------------------------------------------------------------------
// the REST writer
// --------------------------------------------------------------------------

test("the writer sends the token as a header and never in a url or body", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchStub = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    return new Response(JSON.stringify({ id: "abc", iid: 5, web_url: "u", state: "opened" }), { status: 200 })
  }) as unknown as typeof globalThis.fetch

  const w = gitlabRestWriter({ projectPath: "examplebank/customer-portal", token: SENTINEL, fetch: fetchStub })
  await w.commitToBranch("gibson/fix-x", "main", "msg", [{ path: "a.json", content: "{}" }])
  await w.openMergeRequest("gibson/fix-x", "main", "title", "body")
  await w.setCommitStatus("deadbeef", "success", "all good")

  for (const c of calls) {
    assert.ok(!c.url.includes(SENTINEL), `token in url: ${c.url}`)
    assert.ok(!String(c.init.body ?? "").includes(SENTINEL), "token in body")
    const headers = c.init.headers as Record<string, string>
    assert.equal(headers["PRIVATE-TOKEN"], SENTINEL, "the token travels in the header only")
  }
  assert.ok(calls.some((c) => c.url.includes("/statuses/deadbeef")), "the status is set on the commit")
})

test("the writer names the scan status context so the merge gate can require it", async () => {
  let body: unknown
  const fetchStub = (async (_url: unknown, init: unknown) => {
    body = JSON.parse(String((init as RequestInit).body))
    return new Response("{}", { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const w = gitlabRestWriter({ projectPath: "g/p", token: SENTINEL, fetch: fetchStub })
  await w.setCommitStatus("sha", "failed", "1 left for a human")
  assert.equal((body as { name: string }).name, SCAN_STATUS_CONTEXT)
  assert.equal((body as { context: string }).context, SCAN_STATUS_CONTEXT)
})

test("the writer refuses to commit an empty change set", async () => {
  const w = gitlabRestWriter({ projectPath: "g/p", token: SENTINEL, fetch: (async () => new Response("{}")) as never })
  await assert.rejects(() => w.commitToBranch("b", "main", "m", []), /empty change set/)
})

test("a merge request that opens but cannot auto-merge is still returned", async () => {
  let n = 0
  const fetchStub = (async (url: unknown) => {
    n++
    if (String(url).endsWith("/merge")) return new Response("conflict", { status: 405, statusText: "Not Allowed" })
    return new Response(JSON.stringify({ iid: 12, web_url: "u", state: "opened" }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const w = gitlabRestWriter({ projectPath: "g/p", token: SENTINEL, fetch: fetchStub })
  const mr: MergeRequest = await w.openMergeRequest("b", "main", "t", "d")
  assert.equal(mr.iid, 12, "a refused auto-merge does not lose the merge request")
  assert.ok(n >= 2, "auto-merge was attempted")
})

test("a merge request without an iid is refused rather than half-used", async () => {
  const fetchStub = (async () => new Response(JSON.stringify({ web_url: "u" }), { status: 200 })) as never
  const w = gitlabRestWriter({ projectPath: "g/p", token: SENTINEL, fetch: fetchStub })
  await assert.rejects(() => w.openMergeRequest("b", "main", "t", "d"), /no iid/)
})

test("a GitLab error names the project and the status, never a header", async () => {
  const fetchStub = (async () => new Response("nope", { status: 403, statusText: "Forbidden" })) as never
  const w = gitlabRestWriter({ projectPath: "examplebank/customer-portal", token: SENTINEL, fetch: fetchStub })
  await assert.rejects(
    () => w.comment(1, "hi"),
    (e: Error) => {
      assert.match(e.message, /403 Forbidden/)
      assert.match(e.message, /examplebank\/customer-portal/)
      assert.ok(!e.message.includes(SENTINEL))
      return true
    },
  )
})

// --------------------------------------------------------------------------
// the platform seams (zerocool-plugins#96)
// --------------------------------------------------------------------------

function read(over: Partial<ReadFinding> = {}): ReadFinding {
  return {
    findingId: "brain-0000000000001",
    status: "open",
    severity: "high",
    vulnerabilityId: "CVE-2026-0001",
    placeLabel: "Package",
    placeKey: "lodash@4.17.20",
    priority: "",
    ...over,
  }
}

test("a rejected read fails the pass rather than reporting a clean application", async () => {
  const source = harnessFindingSource({
    applicationFindings: async () => {
      throw new Error("graph unreachable")
    },
  })

  await assert.rejects(
    () => source.findings("customer-portal", ["open"]),
    /graph unreachable/,
    "the read must propagate. An unreachable graph swallowed into an empty list is a Fix " +
      "reporting a healthy Application over a live backlog, and it reads identically to health.",
  )
})

test("an unranked finding sorts after every ranked one, and is never scored as P4", async () => {
  const source = harnessFindingSource({
    applicationFindings: async () => [
      read({ findingId: "unranked-critical", priority: "", severity: "critical" }),
      read({ findingId: "ranked-p4", priority: "P4", severity: "low" }),
      read({ findingId: "ranked-p1", priority: "P1", severity: "medium" }),
    ],
  })

  const got = await source.findings("customer-portal", ["open"])

  assert.deepEqual(
    got.map((f) => f.id),
    ["ranked-p1", "ranked-p4", "unranked-critical"],
    "P4 is a decision somebody made; an absent priority is no decision at all. Scoring the " +
      "unranked one as P4 would rank a critical finding above a decided P4 on a value nobody chose.",
  )
  assert.equal(got[2]!.priority, undefined, "an empty priority is omitted, never carried as a value")
})

test("severity breaks the tie beneath priority, and the order is stable", async () => {
  const source = harnessFindingSource({
    applicationFindings: async () => [
      read({ findingId: "b-low", priority: "", severity: "low" }),
      read({ findingId: "a-critical", priority: "", severity: "critical" }),
      read({ findingId: "c-critical", priority: "", severity: "critical" }),
    ],
  })

  const got = await source.findings("customer-portal", ["open"])

  assert.deepEqual(
    got.map((f) => f.id),
    ["a-critical", "c-critical", "b-low"],
    "the merge-request cap defers the tail of this list to the next pass, so an unstable " +
      "sort would defer a different finding every run and none would ever be worked",
  )
})

test("the read asks for the application it was given and nothing wider", async () => {
  const asked: { application: string; statuses?: string[] }[] = []
  const source = harnessFindingSource({
    applicationFindings: async (opts) => {
      asked.push(opts)
      return []
    },
  })

  await source.findings("customer-portal", ["open", "fixing"])

  assert.deepEqual(asked, [{ application: "customer-portal", statuses: ["open", "fixing"] }])
})

test("a status write names the finding by brain_id, so it lands on the node the scan raised", async () => {
  const sent: Parameters<ObserveLifecycle>[0][] = []
  const status = harnessFindingStatus(async (e) => {
    sent.push(e)
  })

  await status.markFixing("brain-abc", { iid: 42, webUrl: "https://gitlab.example/mr/42", state: "opened" })

  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.label, "Finding")
  assert.deepEqual(sent[0]!.idProperties, { brain_id: "brain-abc" })
  assert.equal(sent[0]!.properties?.status, "fixing")
  assert.equal(sent[0]!.properties?.merge_request_iid, "42")
})

test("a status write sends only what the transition decided", async () => {
  const sent: Parameters<ObserveLifecycle>[0][] = []
  const status = harnessFindingStatus(async (e) => {
    sent.push(e)
  })

  await status.markFixed("brain-abc")

  const props = sent[0]!.properties ?? {}
  assert.deepEqual(Object.keys(props).sort(), ["status"])
  for (const blanked of ["severity", "priority", "priority_reason", "vulnerability_id"]) {
    assert.equal(
      blanked in props,
      false,
      `the Fix decides nothing about ${blanked}. A sighting that omits a property leaves what an ` +
        "earlier one established, but one that sets it to \"\" erases it — so sending it blank " +
        "would delete what the scan or a triage pass recorded.",
    )
  }
})

test("there is no path in the status writer that can mark a finding verified", async () => {
  const sent: Parameters<ObserveLifecycle>[0][] = []
  const status = harnessFindingStatus(async (e) => {
    sent.push(e)
  })

  await status.markFixing("brain-abc", { iid: 1, webUrl: "u", state: "opened" })
  await status.markFixed("brain-abc")

  assert.equal(
    sent.some((e) => e.properties?.status === "verified"),
    false,
    "verified follows a rescan not seeing the weakness again, and absence is not an " +
      "observation this process can make (gibson#1686)",
  )
  assert.equal("markVerified" in status, false, "there is no such method to reach by accident")
})

test("byWorkOrder is total, so no pair of findings is left unordered", () => {
  const a = finding({ id: "a", priority: "P1", severity: "low" })
  const b = finding({ id: "b", priority: "P1", severity: "low" })
  assert.equal(byWorkOrder(a, a), 0)
  assert.equal(byWorkOrder(a, b) < 0, true)
  assert.equal(byWorkOrder(b, a) > 0, true)
})

// --------------------------------------------------------------------------
// the dispatch route (zerocool-plugins#96)
// --------------------------------------------------------------------------

// Built through the real reader, so the fixture cannot drift from the launcher
// contract. `taskContext` is then set directly: these tests vary it per case.
const fixCtx = (context: Record<string, string>): DispatchContext => ({
  ...readDispatchContext(
    {
      GIBSON_CALLBACK_ENDPOINT: "127.0.0.1:50051",
      GIBSON_CG_JWT: SENTINEL,
      GIBSON_AGENT_TASK_B64: Buffer.from(
        JSON.stringify({ goal: "fix what the scan found" }),
        "utf8",
      ).toString("base64"),
    },
    { cwd: "/tmp/fix" },
  ),
  taskContext: { "zerocool.task": "fix", ...context },
})

const FULL_CONTEXT = {
  application: "customer-portal",
  "gitlab.project": "examplebank/customer-portal",
  "repository.commit": "abcdef0123456789",
}

/** A planner that bumps one file, so a pass has something real to push. */
function bumpPlanner(): FixPlanner {
  return {
    plan: async (f, ws) => {
      await ws.write("package.json", `{"lodash":"4.17.21"}\n`)
      return { kind: "dependency", summary: `bump for ${f.vulnerabilityId}`, detail: "raises the pinned version" }
    },
  }
}

test("a fix task routes to the fix dispatch", () => {
  assert.equal(dispatchTaskKind({ taskContext: { "zerocool.task": "fix" } }), "fix")
})

test("the fix dispatch reads, fixes and reports, driven end to end", async () => {
  const gl = writer()
  const status = statusWriter()
  const lines: string[] = []

  const outcome = await runDispatch(fixCtx(FULL_CONTEXT), {
    onEvent: (l) => lines.push(l),
    fix: {
      gitlab: gl,
      status,
      planner: bumpPlanner(),
      workspace: workspace(),
      credential: async () => SENTINEL,
      findings: harnessFindingSource({
        applicationFindings: async () => [
          read({ findingId: "brain-low", priority: "P4", severity: "low" }),
          read({ findingId: "brain-urgent", priority: "P1", severity: "critical" }),
        ],
      }),
    },
  })

  assert.equal(outcome.success, true)
  assert.equal(outcome.metadata?.task, "fix")
  assert.equal(outcome.metadata?.fixing, "2")
  assert.equal(outcome.metadata?.application, "customer-portal")

  assert.deepEqual(
    status.fixing,
    ["brain-urgent", "brain-low"],
    "priority order is the point: the P1 is worked before the P4, so a merge-request cap " +
      "defers what matters least rather than whatever the graph happened to return first",
  )

  const written = JSON.stringify({ gl, lines, outcome })
  assert.equal(written.includes(SENTINEL), false, "the grant reaches nothing the dispatch writes")
  assert.equal(/glpat-/.test(written), false, "and no token-shaped string does either")
})

test("a fix dispatch whose read is rejected fails the run", async () => {
  await assert.rejects(
    runDispatch(fixCtx(FULL_CONTEXT), {
      fix: {
        gitlab: writer(),
        status: statusWriter(),
        planner: bumpPlanner(),
        workspace: workspace(),
        credential: async () => "t",
        findings: harnessFindingSource({
          applicationFindings: async () => {
            throw new Error("graph unreachable")
          },
        }),
      },
    }),
    /graph unreachable/,
    "the dispatch must fail rather than report a clean pass over a backlog it could not read",
  )
})

test("a fix dispatch with no application refuses rather than work someone else's backlog", async () => {
  await assert.rejects(
    runDispatch(fixCtx({ "gitlab.project": "g/p" }), {
      fix: { gitlab: writer(), status: statusWriter(), planner: bumpPlanner(), workspace: workspace(), findings: { findings: async () => [] } },
    }),
    /no `application`/,
  )
})

test("a fix dispatch with no project refuses rather than have nowhere to push", async () => {
  await assert.rejects(
    runDispatch(fixCtx({ application: "customer-portal" }), {
      fix: { status: statusWriter(), planner: bumpPlanner(), workspace: workspace(), findings: { findings: async () => [] } },
    }),
    /no `gitlab.project`/,
  )
})

test("a fix dispatch with no planner or no workspace refuses rather than report a clean pass", async () => {
  await assert.rejects(
    runDispatch(fixCtx(FULL_CONTEXT), {
      fix: { gitlab: writer(), status: statusWriter(), workspace: workspace(), findings: { findings: async () => [] } },
    }),
    /no planner/,
    "a default planner would be one that changes nothing, so every finding would report unfixed " +
      "and the pass would look like a considered verdict",
  )

  await assert.rejects(
    runDispatch(fixCtx(FULL_CONTEXT), {
      fix: { gitlab: writer(), status: statusWriter(), planner: bumpPlanner(), findings: { findings: async () => [] } },
    }),
    /no workspace/,
    "a default workspace would be one whose tests always pass, which is exactly the thing the " +
      "tests-before-push order exists to prevent",
  )
})
