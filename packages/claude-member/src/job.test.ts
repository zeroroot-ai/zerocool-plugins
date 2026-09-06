// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { FileJobStore, JobError, JobTable, MemoryJobStore, type JobSpec } from "./job.js"

function spec(jobId: string): JobSpec {
  return {
    jobId,
    goal: `do ${jobId}`,
    repositories: [{ name: "api", connectorRef: "gitlab/acme", cloneUrl: "https://git.example/acme/api.git", baseBranch: "main", deliverable: "MERGE_REQUEST", credentialName: "gitlab-token" }],
    credentialNames: ["gitlab-token"],
    inputNodeIds: [],
    acceptance: "tests pass",
    constraints: {},
  }
}

function table(cap = 1): { t: JobTable; store: MemoryJobStore; tick: (ms: number) => void } {
  const store = new MemoryJobStore()
  let now = 1_000
  return { t: new JobTable({ cap, store, clock: () => now }), store, tick: (ms) => (now += ms) }
}

test("open, working, waiting, working, closed is the whole life of a job", async () => {
  const { t } = table()
  const job = await t.open(spec("j1"))
  assert.equal(job.state, "open")

  await t.startTurn("j1")
  assert.equal(t.get("j1").state, "working")
  assert.equal(t.inFlight, 1)
  assert.equal(t.freeSlots, 0)

  await t.finishTurn("j1", { claudeSessionId: "sess-1", costUsd: 0.25 })
  assert.equal(t.get("j1").state, "waiting")
  assert.equal(t.get("j1").claudeSessionId, "sess-1")
  assert.equal(t.get("j1").turns, 1)

  await t.startTurn("j1")
  await t.finishTurn("j1", { claudeSessionId: "sess-1", costUsd: 0.75 })
  assert.equal(t.get("j1").turns, 2)
  assert.equal(t.get("j1").costUsd, 1)

  const closed = await t.close("j1", "accomplished", 90, "verifier passed")
  assert.equal(closed.state, "closed")
  assert.equal(closed.closure?.verdict, "accomplished")
  assert.equal(closed.closure?.score, 90)
  assert.equal(t.inFlight, 0)
})

test("the worker never closes its own job while a turn is running", async () => {
  const { t } = table()
  await t.open(spec("j1"))
  await t.startTurn("j1")
  await assert.rejects(t.close("j1", "accomplished", 100), (e: JobError) => e.code === "bad_state")
})

test("a waiting job idle past the stale limit closes as abandoned", async () => {
  const { t, tick } = table()
  await t.open(spec("j1"))
  await t.startTurn("j1")
  await t.finishTurn("j1", { costUsd: 0 })
  assert.deepEqual(await t.abandonStale(60_000), [], "not stale yet")
  tick(60_001)
  const abandoned = await t.abandonStale(60_000)
  assert.equal(abandoned.length, 1)
  assert.equal(abandoned[0]!.closure?.verdict, "abandoned")
})

test("a working job is never abandoned by the stale clock", async () => {
  const { t, tick } = table()
  await t.open(spec("j1"))
  await t.startTurn("j1")
  tick(10_000_000)
  assert.deepEqual(await t.abandonStale(1), [])
})

test("an input resets the stale clock", async () => {
  const { t, tick } = table()
  await t.open(spec("j1"))
  await t.startTurn("j1")
  await t.finishTurn("j1", { costUsd: 0 })
  tick(59_000)
  await t.touch("j1")
  tick(59_000)
  assert.deepEqual(await t.abandonStale(60_000), [], "the touch moved the clock")
})

test("the cap bounds turns, not jobs: a second job waits for a free slot", async () => {
  const { t } = table(1)
  await t.open(spec("j1"))
  await t.open(spec("j2"))
  await t.startTurn("j1")
  await assert.rejects(t.startTurn("j2"), (e: JobError) => e.code === "cap_reached")
  await t.finishTurn("j1", { costUsd: 0 })
  await t.startTurn("j2")
  assert.equal(t.get("j2").state, "working")
})

test("a cap of two runs two turns at once", async () => {
  const { t } = table(2)
  await t.open(spec("j1"))
  await t.open(spec("j2"))
  await t.startTurn("j1")
  await t.startTurn("j2")
  assert.equal(t.inFlight, 2)
  assert.equal(t.freeSlots, 0)
})

test("a restart recovers the table, and a job that was mid-turn comes back waiting", async () => {
  const store = new MemoryJobStore()
  const first = new JobTable({ cap: 1, store })
  await first.open(spec("j1"))
  await first.startTurn("j1")

  const second = new JobTable({ cap: 1, store })
  const recovered = await second.load()
  assert.deepEqual(recovered, ["j1"], "a working job at load died mid-turn")
  assert.equal(second.get("j1").state, "waiting")
  assert.equal(second.get("j1").recovered, true)
  assert.equal(second.inFlight, 0, "the slot is free again")
})

test("the table persists to jobs.json and reloads with the spec intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-jobs-"))
  try {
    const path = join(dir, "state", "jobs.json")
    const store = new FileJobStore(path)
    const t = new JobTable({ cap: 1, store })
    await t.open(spec("j1"))
    await t.startTurn("j1")
    await t.finishTurn("j1", { claudeSessionId: "sess-9", costUsd: 2 })

    const raw = JSON.parse(await readFile(path, "utf8")) as { jobs: { jobId: string }[] }
    assert.equal(raw.jobs.length, 1)

    const again = new JobTable({ cap: 1, store: new FileJobStore(path) })
    await again.load()
    assert.equal(again.get("j1").claudeSessionId, "sess-9")
    assert.equal(again.get("j1").spec.goal, "do j1")
    assert.equal(again.get("j1").costUsd, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a missing job file is an empty table, not a failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-jobs-"))
  try {
    const t = new JobTable({ cap: 1, store: new FileJobStore(join(dir, "nothing", "jobs.json")) })
    assert.deepEqual(await t.load(), [])
    assert.deepEqual(t.list(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the same job id is never opened twice", async () => {
  const { t } = table()
  await t.open(spec("j1"))
  await assert.rejects(t.open(spec("j1")), (e: JobError) => e.code === "duplicate")
})

test("an unknown job id is refused rather than invented", async () => {
  const { t } = table()
  assert.throws(() => t.get("nope"), (e: JobError) => e.code === "not_found")
  await assert.rejects(t.startTurn("nope"), (e: JobError) => e.code === "not_found")
})

test("only a closed job is dropped, and the connector refs it held are released", async () => {
  const { t } = table()
  await t.open(spec("j1"))
  assert.deepEqual([...t.connectorRefsInUse()], ["gitlab/acme"])
  await assert.rejects(t.drop("j1"), (e: JobError) => e.code === "bad_state")
  await t.close("j1", "accomplished", 100)
  await t.drop("j1")
  assert.deepEqual([...t.connectorRefsInUse()], [])
  assert.equal(t.has("j1"), false)
})

test("a closed job cannot close twice", async () => {
  const { t } = table()
  await t.open(spec("j1"))
  await t.close("j1", "failed", 10)
  await assert.rejects(t.close("j1", "accomplished", 100), (e: JobError) => e.code === "bad_state")
})

test("a turn only finishes from working", async () => {
  const { t } = table()
  await t.open(spec("j1"))
  await assert.rejects(t.finishTurn("j1", { costUsd: 0 }), (e: JobError) => e.code === "bad_state")
})

test("a cap that is not a positive integer is refused at construction", () => {
  assert.throws(() => new JobTable({ cap: 0, store: new MemoryJobStore() }), /positive integer/)
})
