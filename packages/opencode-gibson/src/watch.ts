// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { buildCreateMissionRequest, remember, taskKnowledge, type TaskHarness } from "@zeroroot-ai/sdk"

import { TRIGGER_STATUS, type GitLabClient, type Pipeline } from "./gitlab.js"

/**
 * The always-on watch loop (zerocool-plugins#88).
 *
 * Dispatched into a `watch-<application>` mission, the agent does not run a
 * task and exit. It polls the application's GitLab project every 30 seconds,
 * and on each finished pipeline on `main` it has not seen it originates a Scan
 * mission, waits for it, and goes back to polling. The loop ends when the
 * mission is cancelled or the sandbox is torn down, not on its own.
 *
 * WHY THE AGENT POLLS RATHER THAN CI CALLING GIBSON. ADR-0063 lets a component
 * originate a mission only from inside one it was dispatched to. A GitLab job
 * is not inside a mission, so it cannot originate a Scan mission whatever
 * credential it holds. The person originates the long-lived watch mission once;
 * every Scan mission after that is originated by the agent from inside it,
 * through `HarnessCallbackService.CreateMission` on the dispatch grant. Since
 * gibson#1657 that RPC takes its parent, tenant and lineage from the resolved
 * harness rather than the request, so the child is attributed to this mission
 * and a caller outside a live mission is refused outright.
 *
 * ONLY THE LATEST PIPELINE IS EVER CONSIDERED. The loop asks GitLab for the
 * most recent successful pipeline on the branch — never for a backlog. That is
 * what makes the checkpoint safe to lose: an unreadable checkpoint costs one
 * redundant Scan of the current head, never a stampede over a project's
 * history. A checkpoint is an optimisation against duplicate work, not a
 * correctness gate, and the loop is written so that is true.
 *
 * THE CHECKPOINT IS AN OBSERVATION, NOT A FILE. The sandbox is ephemeral, so
 * anything written to its disk dies with it. The last pipeline seen goes into
 * the World as a memory observation under the dispatch grant, which is the same
 * write path every other thing the agent learns takes.
 */

/** The observation `kind` the checkpoint is written under. */
export const CHECKPOINT_KIND = "watch-checkpoint"

/** Default poll interval. The issue's cadence, and slow enough for GitLab. */
export const DEFAULT_INTERVAL_MS = 30_000

/** Default ceiling on one Scan mission before the loop stops waiting on it. */
export const DEFAULT_SCAN_TIMEOUT_MS = 30 * 60_000

/** The branch a watch follows unless the task says otherwise. */
export const DEFAULT_REF = "main"

/**
 * Poll state, kept in the World so a restarted agent resumes.
 *
 * `last` returning 0 means "nothing recorded, or the record could not be read".
 * Both are the same instruction to the loop — scan the current head once — so
 * there is nothing here for a caller to distinguish or get wrong.
 */
export interface WatchCheckpoints {
  last(): Promise<number>
  record(p: Pipeline): Promise<void>
}

/** Originates and awaits one Scan mission. */
export interface ScanLauncher {
  /** Create and run the Scan mission for `p`. Returns its mission id. */
  launch(p: Pipeline): Promise<string>
  /** Block until that mission is terminal. Returns its status, for the console. */
  wait(missionId: string): Promise<string>
}

/** One line of the console stream. Rendered as NDJSON by the dispatch driver. */
export type WatchEvent =
  | { type: "watch.start"; application: string; ref: string; lastPipelineId: number }
  | { type: "watch.poll"; application: string; ref: string; pipelineId: number; status: string; fresh: boolean }
  | { type: "watch.scan"; application: string; pipelineId: number; commit: string; missionId: string }
  | { type: "watch.scan.done"; application: string; pipelineId: number; missionId: string; status: string }
  | { type: "watch.error"; application: string; stage: "checkpoint" | "poll" | "scan" | "record"; message: string }

/** What one watch run reports back when it is asked to stop. */
export interface WatchSummary {
  polls: number
  scans: number
  errors: number
  lastPipelineId: number
}

export interface WatchLoopOptions {
  /** The Application this watch follows, e.g. `customer-portal`. */
  application: string
  /** The branch whose pipelines trigger a Scan. */
  ref?: string
  gitlab: GitLabClient
  checkpoints: WatchCheckpoints
  scans: ScanLauncher
  /** Poll cadence. Defaults to {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number
  /** Stop after this many polls. Unset runs until aborted — the real posture. */
  maxPolls?: number
  /** Cooperative stop, so a caller can end the loop between polls. */
  signal?: AbortSignal
  /** Console stream. Every poll emits one line so the ops wall shows life. */
  onEvent?: (e: WatchEvent) => void
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Run the watch loop.
 *
 * Nothing in here throws for an expected failure. A GitLab outage, a refused
 * Scan, a checkpoint that cannot be written — each is reported to the console
 * and the loop keeps polling, because an always-on agent that exits on the
 * first transient error is not always-on. The one thing it will not do is
 * record a checkpoint for a Scan it failed to originate: that pipeline is
 * retried on the next poll.
 */
export async function runWatchLoop(opts: WatchLoopOptions): Promise<WatchSummary> {
  const ref = opts.ref || DEFAULT_REF
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const sleep = opts.sleep ?? defaultSleep
  const emit = (e: WatchEvent): void => opts.onEvent?.(e)
  const summary: WatchSummary = { polls: 0, scans: 0, errors: 0, lastPipelineId: 0 }

  // A checkpoint that cannot be read is not fatal: the loop then treats the
  // current head as fresh and scans it once. See the module note.
  try {
    summary.lastPipelineId = await opts.checkpoints.last()
  } catch (e) {
    summary.errors++
    emit({ type: "watch.error", application: opts.application, stage: "checkpoint", message: message(e) })
  }

  emit({
    type: "watch.start",
    application: opts.application,
    ref,
    lastPipelineId: summary.lastPipelineId,
  })

  while (!opts.signal?.aborted && (opts.maxPolls === undefined || summary.polls < opts.maxPolls)) {
    summary.polls++

    let pipeline: Pipeline | undefined
    try {
      pipeline = await opts.gitlab.latestFinishedPipeline(ref)
    } catch (e) {
      summary.errors++
      emit({ type: "watch.error", application: opts.application, stage: "poll", message: message(e) })
      await pause()
      continue
    }

    const fresh = !!pipeline && pipeline.id > summary.lastPipelineId
    emit({
      type: "watch.poll",
      application: opts.application,
      ref,
      pipelineId: pipeline?.id ?? 0,
      status: pipeline?.status ?? TRIGGER_STATUS,
      fresh,
    })

    if (!pipeline || !fresh) {
      await pause()
      continue
    }

    // Originate, then record, then wait. Recording before the wait means a
    // sandbox that dies mid-Scan does not re-originate the same Scan on
    // restart; recording only after a successful launch means a refused launch
    // is retried on the next poll instead of being silently skipped.
    let missionId: string
    try {
      missionId = await opts.scans.launch(pipeline)
    } catch (e) {
      summary.errors++
      emit({ type: "watch.error", application: opts.application, stage: "scan", message: message(e) })
      await pause()
      continue
    }
    summary.scans++
    emit({
      type: "watch.scan",
      application: opts.application,
      pipelineId: pipeline.id,
      commit: pipeline.sha,
      missionId,
    })

    try {
      await opts.checkpoints.record(pipeline)
    } catch (e) {
      summary.errors++
      emit({ type: "watch.error", application: opts.application, stage: "record", message: message(e) })
    }
    summary.lastPipelineId = pipeline.id

    try {
      const status = await opts.scans.wait(missionId)
      emit({
        type: "watch.scan.done",
        application: opts.application,
        pipelineId: pipeline.id,
        missionId,
        status,
      })
    } catch (e) {
      summary.errors++
      emit({ type: "watch.error", application: opts.application, stage: "scan", message: message(e) })
    }

    await pause()
  }

  return summary

  async function pause(): Promise<void> {
    if (opts.signal?.aborted) return
    if (opts.maxPolls !== undefined && summary.polls >= opts.maxPolls) return
    await sleep(interval)
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// The World-backed checkpoint
// ---------------------------------------------------------------------------

/**
 * The checkpoint fact, in one parseable line.
 *
 * A memory is free text by design, so the loop writes a line it can read back
 * without depending on which properties the projector chose to keep. The
 * application is part of the line, so one tenant's several watches never read
 * each other's checkpoints.
 */
export function checkpointText(application: string, p: Pipeline): string {
  return `${CHECKPOINT_KIND} application=${application} pipeline=${p.id} commit=${p.sha}`
}

/** The checkpoint a line carries, or `undefined` when it is not one. */
export function parseCheckpoint(text: string): { application: string; pipelineId: number; commit: string } | undefined {
  if (!text.startsWith(CHECKPOINT_KIND)) return undefined
  const application = /\bapplication=(\S+)/.exec(text)?.[1] ?? ""
  const pipelineId = Number(/\bpipeline=(\d+)/.exec(text)?.[1] ?? Number.NaN)
  const commit = /\bcommit=(\S+)/.exec(text)?.[1] ?? ""
  if (!application || !Number.isInteger(pipelineId) || pipelineId <= 0) return undefined
  return { application, pipelineId, commit }
}

/**
 * Checkpoints kept in the tenant World under the dispatch grant.
 *
 * The write is `Observe` with a memory shape, which the Taxonomy gate lands as
 * an `Observation` node. The read is the graph query for those observations.
 *
 * DAEMON STATE, and why the loop is built to survive it: the SDK records that
 * `QueryNodes` is declared but not wired at the daemon's registration site and
 * answers `Unimplemented` on a live cluster (gibson#1186). Until that seam is
 * wired, `last` reports 0 and the loop scans the current head once per restart
 * rather than resuming — which is the same behaviour as a first run, and is why
 * the loop never reads a backlog.
 */
export function worldCheckpoints(harness: TaskHarness, application: string): WatchCheckpoints {
  const knowledge = taskKnowledge(harness)
  return {
    async last() {
      const hits = await knowledge.query({
        text: checkpointQueryText(application),
        nodeTypes: ["Observation"],
        topK: 50,
      })
      let max = 0
      for (const hit of hits) {
        const parsed = parseCheckpoint(String(hit.content ?? ""))
        if (parsed && parsed.application === application && parsed.pipelineId > max) {
          max = parsed.pipelineId
        }
      }
      return max
    },
    record: (p) =>
      remember(harness, {
        text: checkpointText(application, p),
        kind: CHECKPOINT_KIND,
        tags: ["watch", `application:${application}`, `pipeline:${p.id}`],
        sourceRef: p.webUrl,
      }),
  }
}

/** The recall text for an application's checkpoints. Exported so a test names it once. */
export function checkpointQueryText(application: string): string {
  return `${CHECKPOINT_KIND} application=${application}`
}

// ---------------------------------------------------------------------------
// The Scan mission
// ---------------------------------------------------------------------------

/**
 * The name of the checked-in Scan mission in gibson's mission catalog.
 *
 * One file in `internal/platform/missioncatalog/missions/` is one mission,
 * named for its file: `scan.cue` is `"scan"`.
 */
export const SCAN_CATALOG_MISSION = "scan"

/** What a Scan mission needs to know about the pipeline that triggered it. */
export interface ScanMissionInputs {
  application: string
  pipeline: Pipeline
  /** The project's clone url, so the Scan mission knows what to check out. */
  repositoryUrl: string
  /** The image the pipeline published, by digest. */
  imageRef: string
}

/**
 * The seven parameters the checked-in Scan mission is rendered with.
 *
 * These names are the catalog's, not ours: `missioncatalog.Params.fields()` is
 * the one declaration of them, and the daemon REFUSES an unrecognised key
 * rather than ignoring it. That refusal is the smuggling defence — `Params` has
 * no target or host field, so the runtime target binds from the mission's
 * `target_id` alone and a caller cannot point a scan at a host the tenant never
 * registered. A key renamed here without renaming it there fails loudly at the
 * next launch, which is the intended outcome.
 *
 * Every one is required. CUE refuses an incomplete render rather than
 * substituting an empty string, so a missing commit fails instead of scanning
 * HEAD and a missing image fails instead of scanning nothing.
 */
export function scanCatalogParams(inputs: ScanMissionInputs): Record<string, string> {
  const { pipeline } = inputs
  return {
    application: inputs.application,
    repositoryUrl: inputs.repositoryUrl,
    ref: pipeline.ref,
    commit: pipeline.sha,
    pipelineId: String(pipeline.id),
    pipelineUrl: pipeline.webUrl,
    imageRef: inputs.imageRef,
  }
}

/** The child mission's name, which is also how a person finds it in the dashboard. */
export function scanMissionName(inputs: ScanMissionInputs): string {
  return `scan ${inputs.application} pipeline ${inputs.pipeline.id}`
}

export interface HarnessScanLauncherOptions {
  /** Everything but the pipeline, which the launcher fills in per trigger. */
  inputs: Omit<ScanMissionInputs, "pipeline">
  /** The target the child mission binds to. Its scope for every observation. */
  targetId: string
  /** Ceiling on one Scan. Defaults to {@link DEFAULT_SCAN_TIMEOUT_MS}. */
  scanTimeoutMs?: number
}

/**
 * A {@link ScanLauncher} over the harness callbacks, on the dispatch grant.
 *
 * `CreateMission` here is the in-mission origination ADR-0063 permits: the
 * daemon resolves the parent from this harness, so the Scan mission is a child
 * of the watch mission and inherits its tenant. Nothing in the request names a
 * parent, a tenant or an originator, so nothing here can widen them.
 *
 * THE MISSION IS NAMED, NOT BUILT (ADR-0018, gibson#1688). The Scan mission is
 * checked into gibson's `missioncatalog` and that copy is authoritative; this
 * launcher sends its name and seven parameters. It used to build its own graph,
 * because `CreateMission` had no way to ask for the catalog's copy — two
 * descriptions of one mission, which is the parallel definition ADR-0027
 * forbids. There is no fallback to the old path: a definition that only one of
 * the two knew about is the drift the single copy exists to prevent.
 *
 * The request goes through the SDK's `buildCreateMissionRequest` rather than
 * being assembled here, because that builder normalises the one trap in this
 * call. `JSON.stringify(undefined)` encodes to zero bytes but
 * `JSON.stringify(null)` encodes to the four-byte string `"null"`, so a graph
 * field filled in unconditionally puts a non-empty body on the wire beside the
 * catalog name; the daemon refuses the pair, and the failure reads as "the
 * catalog path does not work" rather than "you passed a null definition".
 *
 * The response is then sent by hand rather than through `createTaskMission`,
 * for one reason: `CreateMissionResponse` carries an in-band `error`, and the
 * daemon puts its most useful refusals there — an unknown parameter key naming
 * the key and listing the known set, or every missing parameter reported at
 * once. `createTaskMission` reads only `mission`, so those would surface as
 * "returned no mission" and the operator would lose the sentence that says what
 * to fix.
 */
export function harnessScanLauncher(harness: TaskHarness, opts: HarnessScanLauncherOptions): ScanLauncher {
  const timeoutMs = BigInt(opts.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS)
  return {
    async launch(pipeline) {
      const inputs: ScanMissionInputs = { ...opts.inputs, pipeline }
      const wire = buildCreateMissionRequest({
        catalogMission: SCAN_CATALOG_MISSION,
        catalogParams: scanCatalogParams(inputs),
        targetId: opts.targetId,
        name: scanMissionName(inputs),
      })
      const created = await harness.client.createMission({ context: harness.context, ...wire })
      if (created.error) {
        throw new Error(`CreateMission refused: ${created.error.message}`)
      }
      const missionId = created.mission?.id ?? ""
      if (!missionId) {
        throw new Error("CreateMission returned no mission id")
      }
      const run = await harness.client.runMission({
        context: harness.context,
        missionId,
        wait: false,
        timeoutMs: 0n,
      })
      if (run.error) {
        throw new Error(`RunMission refused for ${missionId}: ${run.error.message}`)
      }
      return missionId
    },

    async wait(missionId) {
      const res = await harness.client.waitForMission({ context: harness.context, missionId, timeoutMs })
      if (res.error) {
        throw new Error(`WaitForMission failed for ${missionId}: ${res.error.message}`)
      }
      return String(res.result?.status ?? "")
    },
  }
}
