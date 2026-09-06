// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { runDispatch, type DispatchContext } from "./dispatch.js"
import { gitlabRest, parsePipeline, TRIGGER_STATUS, type GitLabClient, type Pipeline } from "./gitlab.js"
import {
  CHECKPOINT_KIND,
  checkpointText,
  parseCheckpoint,
  runWatchLoop,
  harnessScanLauncher,
  SCAN_CATALOG_MISSION,
  scanCatalogParams,
  scanMissionName,
  type ScanLauncher,
  type WatchCheckpoints,
  type WatchEvent,
} from "./watch.js"

/**
 * The always-on watch loop (zerocool-plugins#88).
 *
 * The property under test: **one finished pipeline produces exactly one Scan
 * mission, ever.** Not two when the loop polls again, not two when the sandbox
 * restarts, and not zero when GitLab or the daemon has a bad minute. The
 * corollary matters as much — the loop never exits on a transient failure,
 * because an always-on agent that dies on the first 502 is not always-on.
 *
 * Nothing here reaches GitLab, a daemon or the World. The GitLab client is a
 * stub over a scripted list of pipelines, the checkpoint store is an in-memory
 * double that survives a simulated restart the way an observation in the World
 * would, and the scan launcher records what it was asked to originate. Time is
 * a stub too, so a loop with a 30-second cadence runs in microseconds.
 */

// --------------------------------------------------------------------------
// doubles
// --------------------------------------------------------------------------

/** A GitLab that answers from a script: one entry consumed per poll. */
function scriptedGitLab(script: (Pipeline | undefined | Error)[]): GitLabClient & { calls: string[] } {
  const calls: string[] = []
  let i = 0
  return {
    calls,
    latestFinishedPipeline: async (ref) => {
      calls.push(ref)
      const step = script[Math.min(i, script.length - 1)]
      i++
      if (step instanceof Error) throw step
      return step
    },
  }
}

/**
 * A checkpoint store that outlives one loop, the way an observation in the
 * World outlives one sandbox. `restart` returns a fresh store over the same
 * backing value — a new process reading state it did not write.
 */
function worldDouble(initial = 0): { store: WatchCheckpoints & { writes: number[] }; value: () => number } {
  let value = initial
  const writes: number[] = []
  return {
    value: () => value,
    store: {
      writes,
      last: async () => value,
      record: async (p) => {
        writes.push(p.id)
        value = p.id
      },
    },
  }
}

/** A scan launcher that records every origination. */
function scanDouble(opts: { launchError?: Error; waitError?: Error } = {}): ScanLauncher & {
  launched: Pipeline[]
  waited: string[]
} {
  const launched: Pipeline[] = []
  const waited: string[] = []
  return {
    launched,
    waited,
    launch: async (p) => {
      if (opts.launchError) throw opts.launchError
      launched.push(p)
      return `mission-${p.id}`
    },
    wait: async (id) => {
      waited.push(id)
      if (opts.waitError) throw opts.waitError
      return "MISSION_STATUS_COMPLETED"
    },
  }
}

const pipeline = (id: number, sha = `sha${id}`): Pipeline => ({
  id,
  sha,
  status: TRIGGER_STATUS,
  ref: "main",
  webUrl: `https://gitlab.com/examplebank/customer-portal/-/pipelines/${id}`,
})

/** Run a loop with time stubbed out and every event captured. */
async function loop(opts: {
  gitlab: GitLabClient
  checkpoints: WatchCheckpoints
  scans: ScanLauncher
  maxPolls: number
}): Promise<{ events: WatchEvent[]; slept: number[]; summary: Awaited<ReturnType<typeof runWatchLoop>> }> {
  const events: WatchEvent[] = []
  const slept: number[] = []
  const summary = await runWatchLoop({
    application: "customer-portal",
    ref: "main",
    gitlab: opts.gitlab,
    checkpoints: opts.checkpoints,
    scans: opts.scans,
    maxPolls: opts.maxPolls,
    onEvent: (e) => events.push(e),
    sleep: async (ms) => {
      slept.push(ms)
    },
  })
  return { events, slept, summary }
}

// --------------------------------------------------------------------------
// the loop stays alive and says so
// --------------------------------------------------------------------------

test("the loop keeps polling and emits one console line per poll", async () => {
  const gitlab = scriptedGitLab([undefined])
  const world = worldDouble()
  const { events, slept, summary } = await loop({
    gitlab,
    checkpoints: world.store,
    scans: scanDouble(),
    maxPolls: 4,
  })

  assert.equal(summary.polls, 4, "the loop polls until it is told to stop, not until it finds work")
  assert.equal(gitlab.calls.length, 4)
  assert.deepEqual(
    events.filter((e) => e.type === "watch.poll").length,
    4,
    "the ops wall shows a line every poll, so an idle agent still looks alive",
  )
  assert.equal(events[0]?.type, "watch.start")
  // Slept between polls but not after the last: a bounded run ends promptly.
  assert.deepEqual(slept, [30_000, 30_000, 30_000])
})

test("the poll interval is configurable and defaults to 30 seconds", async () => {
  const slept: number[] = []
  await runWatchLoop({
    application: "customer-portal",
    gitlab: scriptedGitLab([undefined]),
    checkpoints: worldDouble().store,
    scans: scanDouble(),
    maxPolls: 2,
    intervalMs: 5_000,
    sleep: async (ms) => {
      slept.push(ms)
    },
  })
  assert.deepEqual(slept, [5_000])
})

// --------------------------------------------------------------------------
// one finished pipeline, exactly one Scan mission
// --------------------------------------------------------------------------

test("a finished pipeline originates exactly one Scan mission carrying its id and commit", async () => {
  const gitlab = scriptedGitLab([pipeline(41, "cafebabe")])
  const world = worldDouble()
  const scans = scanDouble()
  const { events, summary } = await loop({ gitlab, checkpoints: world.store, scans, maxPolls: 3 })

  assert.equal(summary.scans, 1, "the same pipeline on later polls is not fresh, so it scans once")
  assert.equal(scans.launched.length, 1)
  assert.equal(scans.launched[0]?.id, 41)
  assert.equal(scans.launched[0]?.sha, "cafebabe")

  const scan = events.find((e) => e.type === "watch.scan")
  assert.deepEqual(scan, {
    type: "watch.scan",
    application: "customer-portal",
    pipelineId: 41,
    commit: "cafebabe",
    missionId: "mission-41",
  })
  assert.equal(
    events.filter((e) => e.type === "watch.scan.done").length,
    1,
    "the loop waits for the Scan before it polls again",
  )
  assert.deepEqual(scans.waited, ["mission-41"])
})

test("a newer pipeline after a scanned one triggers a second Scan", async () => {
  const gitlab = scriptedGitLab([pipeline(41), pipeline(41), pipeline(42)])
  const world = worldDouble()
  const scans = scanDouble()
  await loop({ gitlab, checkpoints: world.store, scans, maxPolls: 3 })

  assert.deepEqual(
    scans.launched.map((p) => p.id),
    [41, 42],
  )
})

test("the checkpoint is recorded only after the Scan is actually originated", async () => {
  const world = worldDouble()
  const scans = scanDouble({ launchError: new Error("CreateMission refused: tenant not enabled") })
  const { events, summary } = await loop({
    gitlab: scriptedGitLab([pipeline(41)]),
    checkpoints: world.store,
    scans,
    maxPolls: 1,
  })

  assert.equal(summary.scans, 0)
  assert.deepEqual(world.store.writes, [], "a refused launch must be retried, so nothing is checkpointed")
  assert.equal(world.value(), 0)
  const err = events.find((e) => e.type === "watch.error")
  assert.equal(err?.type === "watch.error" && err.stage, "scan")
})

// --------------------------------------------------------------------------
// a restart does not rescan
// --------------------------------------------------------------------------

test("a pipeline already seen produces no second Scan after a restart", async () => {
  const world = worldDouble()

  // First process: sees pipeline 41 and scans it.
  const first = scanDouble()
  await loop({ gitlab: scriptedGitLab([pipeline(41)]), checkpoints: world.store, scans: first, maxPolls: 1 })
  assert.deepEqual(
    first.launched.map((p) => p.id),
    [41],
  )
  assert.deepEqual(world.store.writes, [41], "the checkpoint went to the World, not to the sandbox disk")

  // The sandbox is torn down. A new process reads the checkpoint it did not write.
  const second = scanDouble()
  const { summary } = await loop({
    gitlab: scriptedGitLab([pipeline(41)]),
    checkpoints: world.store,
    scans: second,
    maxPolls: 3,
  })

  assert.equal(summary.lastPipelineId, 41)
  assert.deepEqual(second.launched, [], "the restarted agent must not re-scan a pipeline it already scanned")
})

test("an unreadable checkpoint costs one Scan of the head, never a backlog", async () => {
  // The read half of the World store answers Unimplemented (gibson#1186).
  const broken: WatchCheckpoints = {
    last: async () => {
      throw new Error("QueryNodes: unimplemented")
    },
    record: async () => {},
  }
  const scans = scanDouble()
  const { events, summary } = await loop({
    gitlab: scriptedGitLab([pipeline(41)]),
    checkpoints: broken,
    scans,
    maxPolls: 3,
  })

  const err = events.find((e) => e.type === "watch.error")
  assert.equal(err?.type === "watch.error" && err.stage, "checkpoint")
  assert.equal(summary.scans, 1, "exactly one — the loop only ever considers the latest pipeline")
  assert.deepEqual(
    scans.launched.map((p) => p.id),
    [41],
  )
})

// --------------------------------------------------------------------------
// failures are reported and survived
// --------------------------------------------------------------------------

test("a GitLab poll error is reported to the console and the loop continues", async () => {
  const gitlab = scriptedGitLab([new Error("GitLab pipelines returned 502 Bad Gateway"), pipeline(7)])
  const scans = scanDouble()
  const { events, summary } = await loop({
    gitlab,
    checkpoints: worldDouble().store,
    scans,
    maxPolls: 2,
  })

  assert.equal(summary.polls, 2, "the loop did not exit on the error")
  assert.equal(summary.errors, 1)
  const err = events.find((e) => e.type === "watch.error")
  assert.equal(err?.type === "watch.error" && err.stage, "poll")
  assert.match(err?.type === "watch.error" ? err.message : "", /502/)
  assert.deepEqual(
    scans.launched.map((p) => p.id),
    [7],
    "the poll after the failure still triggers its Scan",
  )
})

test("a Scan that fails while being waited on is reported, and the pipeline stays scanned", async () => {
  const world = worldDouble()
  const scans = scanDouble({ waitError: new Error("WaitForMission failed: deadline exceeded") })
  const { events, summary } = await loop({
    gitlab: scriptedGitLab([pipeline(9)]),
    checkpoints: world.store,
    scans,
    maxPolls: 2,
  })

  assert.equal(summary.scans, 1)
  assert.equal(summary.errors, 1)
  assert.deepEqual(world.store.writes, [9], "the Scan was originated, so it is not originated twice")
  assert.equal(events.filter((e) => e.type === "watch.error").length, 1)
})

test("a checkpoint that cannot be written is reported and does not re-originate the Scan", async () => {
  const scans = scanDouble()
  const store: WatchCheckpoints = {
    last: async () => 0,
    record: async () => {
      throw new Error("Observe rejected: transient")
    },
  }
  const { events, summary } = await loop({
    gitlab: scriptedGitLab([pipeline(11)]),
    checkpoints: store,
    scans,
    maxPolls: 3,
  })

  assert.equal(summary.errors, 1)
  const err = events.find((e) => e.type === "watch.error")
  assert.equal(err?.type === "watch.error" && err.stage, "record")
  assert.deepEqual(
    scans.launched.map((p) => p.id),
    [11],
    "the in-memory high-water mark still advanced, so this process does not loop on one pipeline",
  )
})

test("an aborted loop stops between polls", async () => {
  const ac = new AbortController()
  const gitlab: GitLabClient = {
    latestFinishedPipeline: async () => {
      ac.abort()
      return undefined
    },
  }
  const summary = await runWatchLoop({
    application: "customer-portal",
    gitlab,
    checkpoints: worldDouble().store,
    scans: scanDouble(),
    signal: ac.signal,
    sleep: async () => {},
  })
  assert.equal(summary.polls, 1)
})

// --------------------------------------------------------------------------
// the checkpoint line
// --------------------------------------------------------------------------

test("a checkpoint round-trips through the line the World stores", () => {
  const text = checkpointText("customer-portal", pipeline(41, "deadbeef"))
  assert.match(text, new RegExp(`^${CHECKPOINT_KIND} `))
  assert.deepEqual(parseCheckpoint(text), {
    application: "customer-portal",
    pipelineId: 41,
    commit: "deadbeef",
  })
})

test("a line that is not a checkpoint is not read as one", () => {
  for (const text of [
    "",
    "the deploy pipeline is flaky",
    `${CHECKPOINT_KIND} application=customer-portal`,
    `${CHECKPOINT_KIND} pipeline=41 commit=abc`,
    `${CHECKPOINT_KIND} application=customer-portal pipeline=0 commit=abc`,
  ]) {
    assert.equal(parseCheckpoint(text), undefined, `should not parse: ${JSON.stringify(text)}`)
  }
})

// --------------------------------------------------------------------------
// the Scan mission definition
// --------------------------------------------------------------------------

test("the Scan mission is named, not built — the seven catalog parameters, by name", () => {
  const params = scanCatalogParams({
    application: "customer-portal",
    pipeline: pipeline(41, "cafebabe"),
    repositoryUrl: "https://gitlab.com/examplebank/customer-portal.git",
    imageRef: "registry.gitlab.com/examplebank/customer-portal@sha256:abc",
  })

  // Checked by NAME rather than by deepEqual against a literal: the daemon
  // refuses an unrecognised key, so a rename here has to fail on the key that
  // was renamed, not on an opaque object mismatch.
  assert.equal(params.application, "customer-portal")
  assert.equal(params.repositoryUrl, "https://gitlab.com/examplebank/customer-portal.git")
  assert.equal(params.ref, "main")
  assert.equal(params.commit, "cafebabe")
  assert.equal(params.pipelineId, "41")
  assert.equal(params.pipelineUrl, pipeline(41, "cafebabe").webUrl)
  assert.equal(params.imageRef, "registry.gitlab.com/examplebank/customer-portal@sha256:abc")
})

test("no parameter names the runtime target or a host", () => {
  // `missioncatalog.Params` has no target or host field and the daemon refuses
  // an unknown key, so the runtime target can only come from `target_id`. The
  // two url-shaped parameters here are not that: `repositoryUrl` is the git
  // remote to clone and `pipelineUrl` is a link for a human. What must never
  // appear is a parameter naming the thing the runtime scans — this fails the
  // day one is added, which is exactly when it matters.
  const params = scanCatalogParams({
    application: "customer-portal",
    pipeline: pipeline(41, "cafebabe"),
    repositoryUrl: "https://gitlab.com/examplebank/customer-portal.git",
    imageRef: "registry.gitlab.com/examplebank/customer-portal@sha256:abc",
  })

  // The closed set, in the catalog's own names. A parameter added on either
  // side without the other fails here rather than at the next launch.
  assert.deepEqual(Object.keys(params).sort(), [
    "application",
    "commit",
    "imageRef",
    "pipelineId",
    "pipelineUrl",
    "ref",
    "repositoryUrl",
  ])
  for (const key of Object.keys(params)) {
    assert.doesNotMatch(key, /target|\bhost\b|hostname/i, `parameter ${key} is target-shaped`)
  }
})

test("every parameter is non-empty, because CUE refuses an incomplete render", () => {
  const params = scanCatalogParams({
    application: "customer-portal",
    pipeline: pipeline(41, "cafebabe"),
    repositoryUrl: "https://gitlab.com/examplebank/customer-portal.git",
    imageRef: "registry.gitlab.com/examplebank/customer-portal@sha256:abc",
  })
  for (const [key, value] of Object.entries(params)) {
    assert.notEqual(value, "", `parameter ${key} rendered empty`)
  }
})

test("the catalog mission is named for its checked-in definition", () => {
  assert.equal(SCAN_CATALOG_MISSION, "scan")
})

test("the Scan mission name is stable, so a person can find the run for a pipeline", () => {
  const inputs = {
    application: "customer-portal",
    pipeline: pipeline(41),
    repositoryUrl: "https://gitlab.com/examplebank/customer-portal.git",
    imageRef: "registry.gitlab.com/examplebank/customer-portal@sha256:abc",
  }
  assert.equal(scanMissionName(inputs), scanMissionName(inputs))
  assert.match(scanMissionName(inputs), /pipeline 41$/)
})

// --------------------------------------------------------------------------
// the harness Scan launcher
// --------------------------------------------------------------------------

/** The three callbacks the launcher uses, and a record of what it sent. */
function fakeHarness(overrides: { createMission?: (req: Record<string, unknown>) => unknown } = {}) {
  const sent: Record<string, unknown>[] = []
  const harness = {
    context: { missionId: "m-1", taskId: "t-1", agentName: "zerocool" },
    client: {
      async createMission(req: Record<string, unknown>) {
        sent.push(req)
        return overrides.createMission?.(req) ?? { mission: { id: "child-1" } }
      },
      async runMission() {
        return {}
      },
      async waitForMission() {
        return { result: { status: "MISSION_STATUS_COMPLETED" } }
      },
    },
  }
  return { harness: harness as unknown as Parameters<typeof harnessScanLauncher>[0], sent }
}

const LAUNCHER_INPUTS = {
  application: "customer-portal",
  repositoryUrl: "https://gitlab.com/examplebank/customer-portal.git",
  imageRef: "registry.gitlab.com/examplebank/customer-portal@sha256:abc",
}

test("the launcher names the catalog mission and sends NO graph", async () => {
  // The regression this guards is the whole point of gibson#1688: a graph on
  // the wire beside a catalog name is refused by the daemon as InvalidArgument,
  // and the failure reads as "the catalog path does not work" rather than
  // "you sent both". `missionDefinitionJson` must be empty by LENGTH — a
  // literal `null` body is four bytes, not zero.
  const { harness, sent } = fakeHarness()
  const launcher = harnessScanLauncher(harness, { inputs: LAUNCHER_INPUTS, targetId: "target-7" })

  const id = await launcher.launch(pipeline(41, "cafebabe"))

  assert.equal(id, "child-1")
  assert.equal(sent.length, 1)
  const req = sent[0]!
  assert.equal(req.catalogMission, SCAN_CATALOG_MISSION)
  assert.equal((req.missionDefinitionJson as Uint8Array).length, 0)
  assert.equal(req.targetId, "target-7")
  assert.deepEqual(
    req.catalogParams,
    scanCatalogParams({ ...LAUNCHER_INPUTS, pipeline: pipeline(41, "cafebabe") }),
  )
})

test("the target travels as target_id, never as a parameter", async () => {
  const { harness, sent } = fakeHarness()
  const launcher = harnessScanLauncher(harness, { inputs: LAUNCHER_INPUTS, targetId: "target-7" })
  await launcher.launch(pipeline(41, "cafebabe"))

  const params = sent[0]!.catalogParams as Record<string, string>
  assert.equal(sent[0]!.targetId, "target-7")
  for (const value of Object.values(params)) {
    assert.notEqual(value, "target-7", "the target leaked into a catalog parameter")
  }
})

test("the daemon's refusal is reported, not replaced", async () => {
  // CreateMissionResponse carries an in-band `error`, and the daemon's most
  // useful refusals live there: an unknown parameter naming the key and listing
  // the known set, or every missing parameter at once. Losing that message
  // would leave an operator with nothing to act on.
  const { harness } = fakeHarness({
    createMission: () => ({
      error: { message: "missioncatalog: unknown parameter host (known: application, repositoryUrl)" },
    }),
  })
  const launcher = harnessScanLauncher(harness, { inputs: LAUNCHER_INPUTS, targetId: "target-7" })

  await assert.rejects(launcher.launch(pipeline(41, "cafebabe")), /unknown parameter host \(known:/)
})

// --------------------------------------------------------------------------
// the GitLab client
// --------------------------------------------------------------------------

test("the GitLab client asks for the newest successful pipeline on the branch", async () => {
  let seen = ""
  let headers: Record<string, string> = {}
  const client = gitlabRest({
    projectPath: "examplebank/customer-portal",
    token: "glpat-secret",
    fetch: (async (url: string, init: { headers: Record<string, string> }) => {
      seen = url
      headers = init.headers
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [
          { id: 41, sha: "cafebabe", status: "success", ref: "main", web_url: "https://gitlab.com/p/-/pipelines/41" },
        ],
      }
    }) as unknown as typeof globalThis.fetch,
  })

  const p = await client.latestFinishedPipeline("main")
  assert.deepEqual(p, {
    id: 41,
    sha: "cafebabe",
    status: "success",
    ref: "main",
    webUrl: "https://gitlab.com/p/-/pipelines/41",
  })
  assert.match(seen, /\/api\/v4\/projects\/examplebank%2Fcustomer-portal\/pipelines\?/)
  assert.match(seen, /ref=main/)
  assert.match(seen, new RegExp(`status=${TRIGGER_STATUS}`))
  assert.match(seen, /per_page=1/)
  assert.equal(headers["PRIVATE-TOKEN"], "glpat-secret", "a project access token authenticates in this header")
  assert.doesNotMatch(seen, /glpat-secret/, "the token must never reach a URL, which lands in logs")
})

test("a project with no successful pipeline yields no trigger", async () => {
  const client = gitlabRest({
    projectPath: "g/p",
    token: "t",
    fetch: (async () => ({ ok: true, status: 200, statusText: "OK", json: async () => [] })) as unknown as typeof globalThis.fetch,
  })
  assert.equal(await client.latestFinishedPipeline("main"), undefined)
})

test("a GitLab error is raised rather than reported as no pipeline", async () => {
  const client = gitlabRest({
    projectPath: "g/p",
    token: "t",
    fetch: (async () => ({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({}) })) as unknown as typeof globalThis.fetch,
  })
  await assert.rejects(client.latestFinishedPipeline("main"), /401 Unauthorized/)
})

test("a pipeline row without an id or a commit is dropped, not guessed at", () => {
  assert.equal(parsePipeline({ sha: "abc" }), undefined)
  assert.equal(parsePipeline({ id: 1 }), undefined)
  assert.equal(parsePipeline({ id: 0, sha: "abc" }), undefined)
  assert.equal(parsePipeline(null), undefined)
  assert.deepEqual(parsePipeline({ id: 3, sha: "abc" }), {
    id: 3,
    sha: "abc",
    status: "",
    ref: "",
    webUrl: "",
  })
})

// --------------------------------------------------------------------------
// the dispatch
// --------------------------------------------------------------------------

const watchCtx = (context: Record<string, string>): DispatchContext => ({
  callbackEndpoint: "daemon:50001",
  callbackToken: "grant",
  goal: "watch the customer portal",
  taskContext: { "zerocool.task": "watch", ...context },
  workspace: "/tmp/watch",
  timeoutMs: 0,
})

test("the watch dispatch drives the loop and reports what it did", async () => {
  const scans = scanDouble()
  const world = worldDouble()
  const lines: string[] = []
  const outcome = await runDispatch(
    watchCtx({ application: "customer-portal", "gitlab.project": "examplebank/customer-portal" }),
    {
      onEvent: (l) => lines.push(l),
      watch: {
        gitlab: scriptedGitLab([pipeline(41)]),
        checkpoints: world.store,
        scans,
        credential: async () => "unused",
        sleep: async () => {},
        maxPolls: 2,
      },
    },
  )

  assert.equal(outcome.success, true)
  assert.equal(outcome.metadata?.task, "watch")
  assert.equal(outcome.metadata?.scans, "1")
  assert.equal(outcome.metadata?.last_pipeline_id, "41")
  assert.ok(
    lines.some((l) => (JSON.parse(l) as WatchEvent).type === "watch.poll"),
    "poll lines reach the console stream as NDJSON",
  )
})

test("a watch dispatch with no application refuses rather than watch someone else's state", async () => {
  await assert.rejects(
    runDispatch(watchCtx({ "gitlab.project": "g/p" }), {
      watch: { gitlab: scriptedGitLab([undefined]), checkpoints: worldDouble().store, scans: scanDouble(), credential: async () => "t", maxPolls: 1 },
    }),
    /no `application`/,
  )
})

test("a watch dispatch with no project refuses rather than poll nothing", async () => {
  await assert.rejects(
    runDispatch(watchCtx({ application: "customer-portal" }), {
      watch: { checkpoints: worldDouble().store, scans: scanDouble(), credential: async () => "t", maxPolls: 1 },
    }),
    /no `gitlab.project`/,
  )
})

test("a watch that cannot fill the Scan mission's parameters refuses at startup", async () => {
  // Not at the first trigger, which could be hours away. The checked-in Scan
  // mission requires all seven parameters, so a watch missing one is already
  // broken; failing on the first pipeline would read as the pipeline's fault.
  await assert.rejects(
    runDispatch(
      watchCtx({ application: "customer-portal", "gitlab.project": "g/p", "target.id": "target-7" }),
      { watch: { gitlab: scriptedGitLab([undefined]), checkpoints: worldDouble().store, credential: async () => "t", maxPolls: 1 } },
    ),
    /no repository\.url and no image\.ref/,
  )
})

test("the startup check names only the parameter that is actually missing", async () => {
  await assert.rejects(
    runDispatch(
      watchCtx({
        application: "customer-portal",
        "gitlab.project": "g/p",
        "target.id": "target-7",
        "repository.url": "https://gitlab.com/examplebank/customer-portal.git",
      }),
      { watch: { gitlab: scriptedGitLab([undefined]), checkpoints: worldDouble().store, credential: async () => "t", maxPolls: 1 } },
    ),
    /no image\.ref\b(?!.*repository)/,
  )
})
