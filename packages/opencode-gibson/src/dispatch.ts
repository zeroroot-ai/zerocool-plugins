#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * zerocool-dispatch — one sandboxed dispatched run, then exit.
 *
 * The third dispatched shape, and the one gibson launches (zerocool-plugins#57,
 * gibson#1596, ADR-0016). `zerocool-agent` and `zerocool-serve` are long-lived
 * hosts that enroll once, keep a host key, and POLL the daemon for work. This is
 * the opposite: gibson runs an untrusted agent by launching an ephemeral setec
 * sandbox per mission run and injecting the run's credentials as environment. So
 * there is no enrollment, no host key, and no poll loop — the task and the grant
 * are already in the environment when the process starts, and the process serves
 * exactly one dispatch and exits so the sandbox is torn down.
 *
 * WHAT REPLACES THE BOOTSTRAP TOKEN. The poll-loop shapes authenticate as a
 * long-lived COMPONENT: a human mints a one-time `GIBSON_BOOTSTRAP_TOKEN`, the
 * first run trades it for a persistent host key, and every later run re-registers
 * with that key (ADR-0045). A sandboxed run has neither. It authenticates with
 * the PER-DISPATCH capability grant gibson mints for this run and injects as
 * `GIBSON_CALLBACK_ENDPOINT` + `GIBSON_CG_JWT`. That grant carries exactly the
 * authority of this dispatch, so this process never reads a bootstrap token and
 * never touches a host key.
 *
 * THE CALLBACKS ARE GRANT-AUTHENTICATED. This process drives `opencode run`
 * headless and passes the per-dispatch grant to the child (see
 * {@link dispatchChildEnv}). The child's mission callbacks — findings, tool
 * calls, knowledge reads — then reach the daemon's harness callback listener as
 * the TASK, on the injected grant, not as some enrolled component (see
 * `knowledge-source.ts`).
 *
 * THE OUTPUT IS A LIVE NDJSON STREAM. Every event opencode prints is forwarded
 * to this process's stdout as it arrives, so the daemon can stream the run to the
 * read-only console (a later slice consumes it). The last line is the terminal
 * result. stdout is therefore a clean event stream — the driver's own logs go to
 * stderr — and a clean exit lets the sandbox tear down.
 *
 * THE LAUNCHER CONTRACT IS READ ONCE, BY THE SDK. `readSandboxDispatch` from
 * `@zeroroot-ai/sdk` is the one reader of the launch environment in this
 * package, and `sandboxHarness` opens the callbacks on what it read. The
 * launcher names — GIBSON_CG_JWT, GIBSON_CALLBACK_ENDPOINT,
 * GIBSON_AGENT_TASK_B64, GIBSON_MISSION_ID, GIBSON_MISSION_RUN_ID,
 * GIBSON_AGENT_RUN_ID, GIBSON_MODEL, GIBSON_TRACE_ID, GIBSON_SPAN_ID — are
 * spelled in the SDK, against gibson `internal/engine/harness/sandboxed/agent.go`
 * (the `envAgent*` constants). This file spells none of them. A second spelling
 * here is how the two drift, which is the defect zerocool-plugins#7 records.
 *
 * FOUR VARIABLES ARE STILL READ HERE, and every one of them is a local option
 * of this host rather than part of the launcher contract. The launcher never
 * writes any of them, so the SDK carries none of them:
 *
 *   GIBSON_CALLBACK_INSECURE   "1" to dial the callback listener without TLS (kind)
 *   ZEROCOOL_WORKSPACE         working directory (defaults to the cwd)
 *   ZEROCOOL_TASK              force a task kind ("source-analysis", "watch",
 *                              "fix"); the Task's own context `zerocool.task`
 *                              is the normal way
 *   GIBSON_OPENCODE_SESSION_ID continue an earlier opencode session
 *   GIBSON_TIMEOUT_MS          hard deadline for the run, in ms
 *
 * The child `opencode run` still receives the grant as GIBSON_CALLBACK_TOKEN via
 * {@link dispatchChildEnv} — that is the opencode plugin's own contract, fed from
 * the grant the SDK read.
 */
import {
  observe,
  readSandboxDispatch,
  sandboxHarness,
  taskKnowledge,
  type AgentOutcome,
  type SandboxDispatch,
  type TaskHarness,
} from "@zeroroot-ai/sdk"
import { join } from "node:path"

import { taskFindingsBackend, type FindingsBackend } from "./findings.js"
import {
  harnessFindingSource,
  harnessFindingStatus,
  runFix,
  type FindingSource,
  type FindingStatusWriter,
  type FixPlanner,
  type Workspace,
} from "./fix.js"
import { gitlabRest, gitlabRestWriter, type GitLabClient, type GitLabWriter } from "./gitlab.js"
import { runOpencode } from "./opencode-run.js"
import type { SemgrepRunner } from "./semgrep.js"
import {
  DEFAULT_REF,
  harnessScanLauncher,
  runWatchLoop,
  worldCheckpoints,
  type ScanLauncher,
  type WatchCheckpoints,
} from "./watch.js"
import {
  formatSourceAnalysis,
  harnessTriageModel,
  runSourceAnalysis,
  type TriageModel,
} from "./source-analysis.js"

/**
 * The per-dispatch grant as the OPENCODE CHILD receives it.
 *
 * These are `ExecuteRequest` field names, not launcher environment names. The
 * shape is shared with `serve-agent.ts`, which fills it from a polled work
 * item, so the child sees one environment however the run was launched.
 */
export interface CallbackGrant {
  /** `ExecuteRequest.callback_endpoint` — a bare `host:port` or an http(s) URL. */
  callbackEndpoint: string
  /** `ExecuteRequest.callback_token` — the task-scoped capability grant. */
  callbackToken: string
  /** Dial the callback listener without TLS. Only for a local or kind daemon. */
  insecure?: boolean
  /** Provenance the platform correlates the run by. Empty when the caller set none. */
  missionRunId?: string
  agentRunId?: string
  traceId?: string
}

/**
 * Render the per-dispatch grant back to environment for the opencode child, so
 * the child's harness callbacks travel on the task grant rather than on any
 * component identity. Empty fields are omitted rather than set blank.
 *
 * Shared with `serve-agent.ts`, which builds the same passthrough from a polled
 * work item — one definition so the two dispatched shapes hand the child the
 * same environment.
 */
export function dispatchChildEnv(g: CallbackGrant): NodeJS.ProcessEnv {
  return {
    ...(g.callbackEndpoint ? { GIBSON_CALLBACK_ENDPOINT: g.callbackEndpoint } : {}),
    ...(g.callbackToken ? { GIBSON_CALLBACK_TOKEN: g.callbackToken } : {}),
    ...(g.insecure ? { GIBSON_CALLBACK_INSECURE: "1" } : {}),
    ...(g.missionRunId ? { GIBSON_MISSION_RUN_ID: g.missionRunId } : {}),
    ...(g.agentRunId ? { GIBSON_AGENT_RUN_ID: g.agentRunId } : {}),
    ...(g.traceId ? { GIBSON_TRACE_ID: g.traceId } : {}),
  }
}

/**
 * Everything one sandboxed dispatch needs.
 *
 * The launcher contract, exactly as `readSandboxDispatch` read it, plus the
 * local options of this host. Extending {@link SandboxDispatch} rather than
 * copying its fields keeps one name for each thing: the grant is `grant`, the
 * dial target is `callbackEndpoint`, and there is no second spelling to drift.
 */
export interface DispatchContext extends SandboxDispatch {
  /**
   * `task.context` read as strings. The mission node sets it. It selects the
   * task kind (`zerocool.task`) and carries what a task needs beyond a goal:
   * the repository url and commit, a sub-path, the target id.
   */
  taskContext: Record<string, string>
  /** Dial the callback listener without TLS. A local option, not the contract. */
  insecure: boolean
  /** opencode edits files here; it is the run's workspace. */
  workspace: string
  /** Continue an earlier opencode session instead of starting a new one. */
  sessionId?: string
  /** Hard deadline for the run, in ms. `0` when none was set. */
  timeoutMs: number
}

/**
 * Read one `Task.context` entry as a string.
 *
 * `Task.context` is `map<string, gibson.common.v1.TypedValue>`. The SDK parses
 * the launcher's protojson with the generated schema, so every value arrives
 * as the protobuf-es oneof shape and never as a bare string. Reading these
 * maps as plain strings dropped every entry, which is why a mission node's
 * `zerocool.task`, `repository.commit` and `target.id` never reached a run.
 *
 * A null yields no entry: a null is the absence of a value, and rendering it
 * would hand a task a target id of `"null"`. Bytes, arrays and maps yield no
 * entry either — a task reads these keys as single strings.
 */
export function typedValueString(v: SandboxDispatch["task"]["context"][string]): string | undefined {
  switch (v.kind.case) {
    case "stringValue":
      return v.kind.value
    case "intValue":
      return String(v.kind.value)
    case "doubleValue":
      return String(v.kind.value)
    case "boolValue":
      return String(v.kind.value)
    default:
      return undefined
  }
}

/** The whole context map as strings. Entries with no readable value are dropped. */
export function taskContextStrings(context: SandboxDispatch["task"]["context"]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(context ?? {})) {
    const s = typedValueString(v)
    if (s !== undefined) out[k] = s
  }
  return out
}

/** The task kinds a sandboxed dispatch can serve. */
export type DispatchTaskKind = "opencode" | "source-analysis" | "watch" | "fix"

/**
 * Which task this dispatch runs. The mission node says so in the Task's
 * context (`zerocool.task`); ZEROCOOL_TASK forces it for a hand-run sandbox.
 * Anything unrecognized is the default: drive opencode on the goal.
 */
export function dispatchTaskKind(ctx: Pick<DispatchContext, "taskContext">, env: NodeJS.ProcessEnv = {}): DispatchTaskKind {
  const kind = env.ZEROCOOL_TASK ?? ctx.taskContext["zerocool.task"] ?? ""
  if (kind === "source-analysis") return "source-analysis"
  if (kind === "watch") return "watch"
  if (kind === "fix") return "fix"
  return "opencode"
}

/**
 * Read one sandboxed dispatch from the environment.
 *
 * The launcher contract comes from `readSandboxDispatch`, which is the one
 * reader of those names on the TypeScript side. It fails, never falls back: a
 * launch without a grant, an endpoint or a task is a defect in the launch, not
 * something to guess around by running opencode with no task or by making
 * unauthenticated calls.
 *
 * Deliberately never reads `GIBSON_BOOTSTRAP_TOKEN` or a host key: a sandboxed
 * run is authenticated by its per-dispatch grant alone, and reaching for a
 * bootstrap token here would reintroduce the enrollment handshake this shape
 * exists to avoid.
 *
 * What this adds on top are this host's own options — the workspace, the
 * deadline, the opencode session to continue, and whether to dial the callback
 * listener without TLS. The launcher writes none of them, so the SDK carries
 * none of them, and reading them here is not a second spelling of the contract.
 */
export function readDispatchContext(
  env: NodeJS.ProcessEnv,
  opts: { cwd?: string } = {},
): DispatchContext {
  const dispatch = readSandboxDispatch(env)
  const timeoutRaw = env.GIBSON_TIMEOUT_MS ? Number(env.GIBSON_TIMEOUT_MS) : 0
  return {
    ...dispatch,
    taskContext: taskContextStrings(dispatch.task.context),
    insecure: env.GIBSON_CALLBACK_INSECURE === "1",
    workspace: env.ZEROCOOL_WORKSPACE ?? opts.cwd ?? process.cwd(),
    ...(env.GIBSON_OPENCODE_SESSION_ID ? { sessionId: env.GIBSON_OPENCODE_SESSION_ID } : {}),
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 0,
  }
}

/**
 * The task harness for this dispatch: the grant the launch injected, nothing
 * else. `sandboxHarness` is the SDK's opener for exactly this shape.
 */
export function dispatchHarness(ctx: DispatchContext): TaskHarness {
  return sandboxHarness(ctx, { insecure: ctx.insecure })
}

/** Injectable seams, so a test drives a dispatch without spawning opencode. */
export interface DispatchDeps {
  /** Overridable opencode driver. */
  run?: typeof runOpencode
  /** Live tap for each NDJSON event opencode prints. */
  onEvent?: (line: string) => void
  /** Source-analysis seams: no semgrep binary, no model, no daemon in a test. */
  semgrep?: SemgrepRunner
  model?: TriageModel
  findings?: FindingsBackend
  /** Opens the task harness. Defaults to {@link dispatchHarness} on the dispatch grant. */
  harness?: (ctx: DispatchContext) => TaskHarness
  /** Force the task kind, over the Task's own context. */
  taskKind?: DispatchTaskKind
  /** Watch seams: no GitLab, no World and no child missions in a test. */
  watch?: WatchDeps
  /** Fix seams: no GitLab, no graph and no checkout in a test. */
  fix?: FixDeps
}

/**
 * The fix task's injectable seams.
 *
 * `planner` and `workspace` have no default. The Fix decides what to change
 * and runs the repository's own tests before anything is pushed, and neither
 * is something this process can synthesise: a default planner would be one
 * that changes nothing, and a default workspace would be one whose tests
 * always pass. Both would turn a missing dependency into a Fix that reports
 * success having done nothing, so a dispatch without them fails instead.
 */
export interface FixDeps {
  gitlab?: GitLabWriter
  findings?: FindingSource
  status?: FindingStatusWriter
  planner?: FixPlanner
  workspace?: Workspace
  /** Resolve the GitLab token. Defaults to the harness `GetCredential`. */
  credential?: (name: string) => Promise<string>
  /** Cap on merge requests opened by one pass. */
  maxMergeRequests?: number
}

/** The watch task's injectable seams. Everything the loop reaches out through. */
export interface WatchDeps {
  gitlab?: GitLabClient
  checkpoints?: WatchCheckpoints
  scans?: ScanLauncher
  /** Resolve the GitLab token. Defaults to the harness `GetCredential`. */
  credential?: (name: string) => Promise<string>
  sleep?: (ms: number) => Promise<void>
  /** Bound the loop. Unset runs until the sandbox is torn down. */
  maxPolls?: number
  signal?: AbortSignal
}

/**
 * Run one dispatched Task headless and map it to a terminal outcome.
 *
 * The opencode child inherits the per-dispatch grant, so its findings, tool
 * calls and knowledge reads authenticate as the task. Events stream live through
 * `deps.onEvent`. A crashed or timed-out run throws — {@link main} turns that
 * into a failed terminal result and a non-zero exit.
 */
export async function runDispatch(ctx: DispatchContext, deps: DispatchDeps = {}): Promise<AgentOutcome> {
  const kind = deps.taskKind ?? dispatchTaskKind(ctx, process.env)
  if (kind === "source-analysis") {
    return runSourceAnalysisDispatch(ctx, deps)
  }
  if (kind === "watch") {
    return runWatchDispatch(ctx, deps)
  }
  if (kind === "fix") {
    return runFixDispatch(ctx, deps)
  }
  const run = deps.run ?? runOpencode
  const result = await run({
    goal: ctx.goal,
    dir: ctx.workspace,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.timeoutMs > 0 ? { timeoutMs: ctx.timeoutMs } : {}),
    // The child speaks the opencode plugin's own contract, whose token name is
    // GIBSON_CALLBACK_TOKEN. It is fed from the grant the SDK read.
    env: dispatchChildEnv({
      callbackEndpoint: ctx.callbackEndpoint,
      callbackToken: ctx.grant,
      insecure: ctx.insecure,
      missionRunId: ctx.missionRunId,
      agentRunId: ctx.agentRunId,
      traceId: ctx.traceId,
    }),
    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
  })

  return {
    output: result.text,
    success: true,
    metadata: {
      opencode_session_id: result.sessionId,
      finish_reason: result.finishReason,
      tokens_total: String(result.tokens.total),
      tokens_output: String(result.tokens.output),
      cost: String(result.cost),
    },
  }
}

/**
 * The source-analysis task, sandboxed (zerocool-plugins#87). opencode is not
 * involved: semgrep produces candidates, the model triages them through the
 * harness `LLMComplete` on the task grant, and real ones are submitted through
 * the harness `SubmitFinding` on the same grant. The task reads the checkout
 * (the workspace, or `source.path` under it) and changes nothing.
 *
 * Task context keys it reads: `zerocool.task` (selector), `source.path`,
 * `repository.url`, `repository.commit`, `target.id`.
 */
export async function runSourceAnalysisDispatch(ctx: DispatchContext, deps: DispatchDeps = {}): Promise<AgentOutcome> {
  const opened = !deps.harness && !(deps.model && deps.findings)
  const harness: TaskHarness | undefined =
    deps.model && deps.findings
      ? undefined
      : (deps.harness ?? dispatchHarness)(ctx)
  const model = deps.model ?? harnessTriageModel(harness as TaskHarness)
  const findings = deps.findings ?? taskFindingsBackend(harness as TaskHarness)
  const sub = ctx.taskContext["source.path"]
  const dir = sub ? join(ctx.workspace, sub) : ctx.workspace

  try {
    const summary = await runSourceAnalysis({
      dir,
      model,
      findings,
      ...(deps.semgrep ? { semgrep: deps.semgrep } : {}),
      ...(ctx.timeoutMs > 0 ? { semgrepTimeoutMs: ctx.timeoutMs } : {}),
      provenance: {
        ...(ctx.missionId ? { missionId: ctx.missionId } : {}),
        ...(ctx.taskContext["repository.url"] ? { repository: ctx.taskContext["repository.url"] } : {}),
        ...(ctx.taskContext["repository.commit"] ? { commit: ctx.taskContext["repository.commit"] } : {}),
        ...(ctx.taskContext["target.id"] ? { targetId: ctx.taskContext["target.id"] } : {}),
      },
      ...(deps.onEvent ? { onEvent: (event) => deps.onEvent?.(JSON.stringify(event)) } : {}),
    })
    return {
      output: formatSourceAnalysis(summary),
      success: true,
      findingIds: summary.findingIds,
      metadata: {
        task: "source-analysis",
        matches: String(summary.matches),
        candidates: String(summary.candidates),
        real: String(summary.real),
        noise: String(summary.noise),
        submitted: String(summary.findingIds.length),
        failed: String(summary.failed.length),
      },
    }
  } finally {
    if (opened) harness?.stop()
  }
}

/**
 * The watch task, sandboxed (zerocool-plugins#88). The always-on shape: this
 * dispatch does not finish until the mission is cancelled or the sandbox is
 * torn down. It polls the application's GitLab project and originates a Scan
 * mission per finished pipeline on the branch, from inside this very mission
 * (ADR-0063). See `watch.ts` for why the agent polls rather than CI calling in.
 *
 * Task context keys it reads:
 *   `zerocool.task`        selector, "watch"
 *   `application`          the Application this watch follows (required)
 *   `gitlab.project`       `group/project` on the instance (required)
 *   `gitlab.url`           instance base url; defaults to gitlab.com
 *   `gitlab.ref`           branch to watch; defaults to `main`
 *   `gitlab.credential`    tenant secret holding the project access token
 *   `repository.url`       clone url the Scan mission checks out (required)
 *   `image.ref`            the image the pipeline published, by digest (required)
 *   `target.id`            the registered target each Scan mission binds to
 *   `watch.interval_ms`    poll cadence; defaults to 30s
 */
export async function runWatchDispatch(ctx: DispatchContext, deps: DispatchDeps = {}): Promise<AgentOutcome> {
  const w = deps.watch ?? {}
  const application = ctx.taskContext.application || ""
  const projectPath = ctx.taskContext["gitlab.project"] || ""
  const ref = ctx.taskContext["gitlab.ref"] || DEFAULT_REF
  const targetId = ctx.taskContext["target.id"] || ""
  const credentialName = ctx.taskContext["gitlab.credential"] || "gitlab-token"
  const repositoryUrl = ctx.taskContext["repository.url"] || ""
  const imageRef = ctx.taskContext["image.ref"] || ""

  if (!application) {
    throw new Error(
      "watch: the mission node set no `application` in the task context. The watch keys its " +
        "checkpoints and its Scan missions by Application; without one it cannot tell its own " +
        "state from another watch's.",
    )
  }
  if (!w.gitlab && !projectPath) {
    throw new Error(
      "watch: the mission node set no `gitlab.project` in the task context, so there is no " +
        "project to poll.",
    )
  }
  // Checked here, not at the first trigger. The checked-in Scan mission requires
  // all seven of its parameters — CUE refuses an incomplete render rather than
  // substituting an empty string — so a watch missing one is already broken. It
  // would otherwise poll cleanly for hours and fail on the first pipeline, at
  // which point the failure looks like the pipeline's fault rather than the
  // watch's configuration.
  if (!w.scans) {
    const missing = [
      ...(repositoryUrl ? [] : ["repository.url"]),
      ...(imageRef ? [] : ["image.ref"]),
    ]
    if (missing.length > 0) {
      throw new Error(
        `watch: the mission node set no ${missing.join(" and no ")} in the task context. The ` +
          "checked-in Scan mission requires every one of its seven parameters, so a Scan " +
          "originated without these would be refused rather than run.",
      )
    }
  }

  // A harness is opened unless every seam that would use one was injected.
  const needsHarness = !w.gitlab || !w.checkpoints || !w.scans || !w.credential
  const opened = needsHarness && !deps.harness
  const harness: TaskHarness | undefined = needsHarness ? (deps.harness ?? dispatchHarness)(ctx) : undefined

  try {
    const gitlab =
      w.gitlab ??
      gitlabRest({
        projectPath,
        token: await (w.credential ?? harnessCredential(harness as TaskHarness))(credentialName),
        ...(ctx.taskContext["gitlab.url"] ? { baseUrl: ctx.taskContext["gitlab.url"] } : {}),
      })
    const checkpoints: WatchCheckpoints = w.checkpoints ?? worldCheckpoints(harness as TaskHarness, application)
    const scans: ScanLauncher =
      w.scans ??
      harnessScanLauncher(harness as TaskHarness, {
        targetId,
        inputs: { application, repositoryUrl, imageRef },
      })

    const intervalMs = Number(ctx.taskContext["watch.interval_ms"] || Number.NaN)
    const summary = await runWatchLoop({
      application,
      ref,
      gitlab,
      checkpoints,
      scans,
      ...(Number.isFinite(intervalMs) && intervalMs > 0 ? { intervalMs } : {}),
      ...(w.maxPolls !== undefined ? { maxPolls: w.maxPolls } : {}),
      ...(w.signal ? { signal: w.signal } : {}),
      ...(w.sleep ? { sleep: w.sleep } : {}),
      ...(deps.onEvent ? { onEvent: (e) => deps.onEvent?.(JSON.stringify(e)) } : {}),
    })

    return {
      output:
        `watch ${application}@${ref}: ${summary.polls} polls, ${summary.scans} scan missions, ` +
        `${summary.errors} errors; last pipeline ${summary.lastPipelineId || "none"}`,
      success: true,
      metadata: {
        task: "watch",
        application,
        ref,
        polls: String(summary.polls),
        scans: String(summary.scans),
        errors: String(summary.errors),
        last_pipeline_id: String(summary.lastPipelineId),
      },
    }
  } finally {
    if (opened) harness?.stop()
  }
}

/**
 * The fix task, sandboxed (zerocool-plugins#89, finished in #96).
 *
 * What the always-on agent does after a Scan mission lands: read the
 * Application's Findings over the task grant, work them in priority order,
 * and for each one it can act on rewrite the repository, run the repository's
 * own tests, and only then open a merge request that merges itself on a green
 * pipeline. See `fix.ts` for why the order is tests-then-push and why this
 * never marks a Finding `verified`.
 *
 * THE READ AND THE STATUS WRITE TRAVEL ON THE DISPATCH GRANT, not on a
 * component identity — this process has none. `applicationFindings` and
 * `observe` both reach the daemon as the task, so the run holds exactly the
 * authority its dispatch granted.
 *
 * A REJECTED READ FAILS THE RUN. `harnessFindingSource` does not catch it, and
 * neither does this: an unreachable graph reported as an empty backlog is a
 * Fix that says the Application is clean while the backlog is live, and it
 * reads identically to health.
 *
 * Task context keys it reads:
 *   `zerocool.task`        selector, "fix"
 *   `application`          the Application whose Findings are worked (required)
 *   `gitlab.project`       `group/project` on the instance (required)
 *   `gitlab.url`           instance base url; defaults to gitlab.com
 *   `gitlab.ref`           branch merge requests target; defaults to `main`
 *   `gitlab.credential`    tenant secret holding the project access token
 *   `repository.commit`    the commit the Scan ran against — what the status lands on
 *   `pipeline.url`         the pipeline page, linked from the commit status
 *   `fix.max_merge_requests`  cap on merge requests opened in one pass
 */
export async function runFixDispatch(ctx: DispatchContext, deps: DispatchDeps = {}): Promise<AgentOutcome> {
  const f = deps.fix ?? {}
  const application = ctx.taskContext.application || ""
  const projectPath = ctx.taskContext["gitlab.project"] || ""
  const targetRef = ctx.taskContext["gitlab.ref"] || DEFAULT_REF
  const commit = ctx.taskContext["repository.commit"] || ""
  const credentialName = ctx.taskContext["gitlab.credential"] || "gitlab-token"

  if (!application) {
    throw new Error(
      "fix: the mission node set no `application` in the task context. The Fix reads one " +
        "Application's Findings and writes back to them; without one it cannot tell which " +
        "backlog it is working.",
    )
  }
  if (!f.gitlab && !projectPath) {
    throw new Error(
      "fix: the mission node set no `gitlab.project` in the task context, so there is no " +
        "project to open a merge request against.",
    )
  }
  // No default planner and no default workspace: see FixDeps. A Fix that
  // cannot change anything or cannot test what it changed must not report a
  // clean pass over a backlog it never touched.
  if (!f.planner) {
    throw new Error("fix: no planner was supplied, so this dispatch could only report every finding unfixed")
  }
  if (!f.workspace) {
    throw new Error("fix: no workspace was supplied, so no change could be made or tested")
  }

  const needsHarness = !f.gitlab || !f.findings || !f.status || !f.credential
  const opened = needsHarness && !deps.harness
  const harness: TaskHarness | undefined = needsHarness ? (deps.harness ?? dispatchHarness)(ctx) : undefined

  try {
    const gitlab =
      f.gitlab ??
      gitlabRestWriter({
        projectPath,
        token: await (f.credential ?? harnessCredential(harness as TaskHarness))(credentialName),
        ...(ctx.taskContext["gitlab.url"] ? { baseUrl: ctx.taskContext["gitlab.url"] } : {}),
      })
    const findings = f.findings ?? harnessFindingSource(taskKnowledge(harness as TaskHarness))
    const status =
      f.status ??
      harnessFindingStatus((entity) => observe(harness as TaskHarness, { lifecycleEntity: entity }))

    const cap = Number(ctx.taskContext["fix.max_merge_requests"] || Number.NaN)
    const summary = await runFix({
      application,
      commit,
      targetRef,
      findings,
      status,
      planner: f.planner,
      workspace: f.workspace,
      gitlab,
      ...(ctx.taskContext["pipeline.url"] ? { pipelineUrl: ctx.taskContext["pipeline.url"] } : {}),
      ...(f.maxMergeRequests !== undefined
        ? { maxMergeRequests: f.maxMergeRequests }
        : Number.isFinite(cap) && cap > 0
          ? { maxMergeRequests: cap }
          : {}),
      ...(deps.onEvent ? { onEvent: (e) => deps.onEvent?.(JSON.stringify(e)) } : {}),
    })

    const fixing = summary.outcomes.filter((o) => o.result === "fixing").length
    const merged = summary.outcomes.filter((o) => o.result === "merged").length
    const unfixed = summary.outcomes.filter((o) => o.result === "unfixed").length
    return {
      output:
        `fix ${application}@${commit.slice(0, 12) || "unknown"}: ${fixing} merge request(s) opened, ` +
        `${merged} merged, ${unfixed} left for a human`,
      success: true,
      metadata: {
        task: "fix",
        application,
        commit,
        fixing: String(fixing),
        merged: String(merged),
        unfixed: String(unfixed),
      },
    }
  } finally {
    if (opened) harness?.stop()
  }
}

/**
 * Resolve a tenant secret through the harness on the dispatch grant. The value
 * is returned to the caller and never logged: it is the GitLab token, and the
 * console stream this dispatch writes is shown in the browser.
 */
export function harnessCredential(harness: TaskHarness): (name: string) => Promise<string> {
  return async (name) => {
    const res = await harness.client.getCredential({ context: harness.context, name })
    if (res.error) {
      throw new Error(`GetCredential(${name}) refused: ${res.error.message}`)
    }
    const secret = res.credential?.secretData
    const value =
      secret?.case === "apiKey" || secret?.case === "bearerToken" || secret?.case === "customSecret"
        ? secret.value
        : undefined
    if (!value) {
      throw new Error(
        `GetCredential(${name}) returned no usable secret. A GitLab project access token is ` +
          "stored as an api key, a bearer token, or a single-valued custom secret.",
      )
    }
    return value
  }
}

/**
 * Render a terminal outcome as the last NDJSON line on stdout.
 *
 * `type: "result"` marks it apart from the streamed opencode events on the same
 * stream, so the sandbox launcher reads the run's result from the one line that
 * carries it.
 */
export function formatTerminalResult(outcome: AgentOutcome): string {
  return JSON.stringify({
    type: "result",
    success: outcome.success ?? true,
    output: outcome.output ?? "",
    ...(outcome.findingIds ? { finding_ids: outcome.findingIds } : {}),
    metadata: outcome.metadata ?? {},
  })
}

async function main(): Promise<void> {
  let ctx: DispatchContext
  try {
    ctx = readDispatchContext(process.env)
  } catch (e) {
    // A launch defect, not a run failure. Say so on stderr and still emit a
    // terminal result so the launcher never blocks waiting for one.
    const message = (e as Error).message
    console.error(`[zerocool-dispatch] ${message}`)
    process.stdout.write(`${formatTerminalResult({ success: false, output: message, metadata: { error: message } })}\n`)
    process.exit(2)
    return
  }

  console.error(
    `[zerocool-dispatch] run mission=${ctx.missionRunId || "-"} agent=${ctx.agentRunId || "-"} ` +
      `workspace=${ctx.workspace}; callbacks use the per-dispatch grant`,
  )

  try {
    const outcome = await runDispatch(ctx, {
      // Forward every opencode event to our stdout, live, for the console stream.
      onEvent: (line) => process.stdout.write(`${line}\n`),
    })
    process.stdout.write(`${formatTerminalResult(outcome)}\n`)
    console.error(
      `[zerocool-dispatch] done reason=${outcome.metadata?.finish_reason ?? "-"} ` +
        `tokens=${outcome.metadata?.tokens_total ?? "-"}`,
    )
    process.exit(0)
  } catch (e) {
    const message = (e as Error).message
    console.error(`[zerocool-dispatch] run failed: ${message}`)
    process.stdout.write(`${formatTerminalResult({ success: false, output: message, metadata: { error: message } })}\n`)
    process.exit(1)
  }
}

// Only run when executed as the bin, so the functions above stay importable.
if (process.argv[1]?.endsWith("dispatch.js")) {
  main().catch((e: unknown) => {
    console.error(`[zerocool-dispatch] fatal: ${(e as Error).message}`)
    process.exit(1)
  })
}
