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
 * Environment (injected by the sandbox launch):
 *
 * These names are gibson's canonical dispatch contract — the constants in gibson
 * `internal/engine/harness/sandboxed/agent.go` (envAgent*). This process conforms
 * to them; it does not define its own.
 *
 *   GIBSON_CALLBACK_ENDPOINT   per-dispatch harness callback dial target (required)
 *   GIBSON_CG_JWT              per-dispatch capability grant (CG-JWT)    (required)
 *   GIBSON_AGENT_TASK_B64      base64 protojson gibson.types.v1.Task     (required)
 *   GIBSON_MODEL               provider/model resolved for the tenant at dispatch
 *   GIBSON_CALLBACK_INSECURE   "1" to dial the callback listener without TLS (kind)
 *   GIBSON_MISSION_ID / GIBSON_MISSION_RUN_ID / GIBSON_AGENT_RUN_ID   provenance
 *   ZEROCOOL_WORKSPACE         working directory (defaults to the cwd)
 *   ZEROCOOL_TASK              force a task kind ("source-analysis", "watch",
 *                              "fix"); the Task's own context `zerocool.task`
 *                              is the normal way
 *   GIBSON_OPENCODE_SESSION_ID continue an earlier opencode session
 *   GIBSON_TIMEOUT_MS          hard deadline for the run, in ms
 *
 * The child `opencode run` still receives the grant as GIBSON_CALLBACK_TOKEN via
 * {@link dispatchChildEnv} — that is the opencode plugin's own contract, fed from
 * the GIBSON_CG_JWT this process reads.
 */
import { observe, openTaskHarness, taskKnowledge, type AgentOutcome, type TaskHarness } from "@zeroroot-ai/sdk"
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
 * The per-dispatch grant, as the sandbox injects it. The child authenticates its
 * harness callbacks with this; {@link dispatchChildEnv} renders it back to env.
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

/** Everything one sandboxed dispatch needs, read from the environment. */
export interface DispatchContext extends CallbackGrant {
  /** `task.goal` — the natural-language objective the sandbox handed over. */
  goal: string
  /**
   * `task.context` — the string map the mission node set. Selects the task kind
   * (`zerocool.task`) and carries what a task needs beyond a goal: the
   * repository url and commit, a sub-path, the target id.
   */
  taskContext: Record<string, string>
  /** `GIBSON_MISSION_ID`, so a Finding names the mission it belongs to. */
  missionId?: string
  /** opencode edits files here; it is the run's workspace. */
  workspace: string
  /** `provider/model`, e.g. `gibson/default`. Omitted lets opencode choose. */
  model?: string
  /** Continue an earlier opencode session instead of starting a new one. */
  sessionId?: string
  /** Hard deadline for the run, in ms. `0` when none was set. */
  timeoutMs: number
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
 * Decode the base64 protojson `gibson.types.v1.Task` the sandbox launch injects
 * as `GIBSON_AGENT_TASK_B64` (gibson agent.go `envAgentTaskB64`) and return its
 * goal. gibson sends the full typed Task, not a plain goal string, so decode it
 * here rather than run opencode against an empty or malformed prompt.
 */
export function decodeTaskGoal(taskB64: string | undefined): string {
  return decodeTask(taskB64).goal
}

/** The parts of a `gibson.types.v1.Task` a dispatch reads. */
export interface DecodedTask {
  goal: string
  context: Record<string, string>
  metadata: Record<string, string>
}

/**
 * Decode the whole Task: the goal, and the `context` and `metadata` string
 * maps a mission node sets. protojson renders both as plain objects, so a
 * value that is not a string is dropped rather than guessed at.
 */
export function decodeTask(taskB64: string | undefined): DecodedTask {
  if (!taskB64) {
    throw new Error(
      "GIBSON_AGENT_TASK_B64 is not set. The sandbox launch injects the task to pursue as the " +
        "base64 protojson of a gibson.types.v1.Task; without it there is nothing to run.",
    )
  }
  let task: { goal?: unknown; context?: unknown; metadata?: unknown }
  try {
    task = JSON.parse(Buffer.from(taskB64, "base64").toString("utf8")) as typeof task
  } catch (e) {
    throw new Error(
      "GIBSON_AGENT_TASK_B64 is not valid base64 protojson of a gibson.types.v1.Task: " +
        (e instanceof Error ? e.message : String(e)),
    )
  }
  const goal = typeof task.goal === "string" ? task.goal.trim() : ""
  if (!goal) {
    throw new Error(
      "GIBSON_AGENT_TASK_B64 decoded to a Task with no goal. Running opencode against an empty " +
        "prompt would report whatever it says back as a mission result.",
    )
  }
  return { goal, context: stringMap(task.context), metadata: stringMap(task.metadata) }
}

function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = typedValueString(val)
    if (s !== undefined) out[k] = s
  }
  return out
}

/**
 * Read one `Task.context` / `Task.metadata` entry as a string.
 *
 * Both maps are `map<string, gibson.common.v1.TypedValue>`, so canonical
 * protojson renders every value as a one-key object naming the oneof arm —
 * `{"stringValue":"source-analysis"}`, `{"intValue":"42"}` — never as a bare
 * string. gibson marshals the Task with `protojson.Marshal` over
 * `agent.TaskToProto`, which wraps each entry with `mapToTypedValueMap`, so
 * this is the only shape a dispatched agent ever receives. Reading these maps
 * as plain strings silently dropped every entry, which is why a mission node's
 * `zerocool.task`, `repository.commit` and `target.id` never reached the run.
 *
 * A bare string is still accepted, because a hand-built Task written as plain
 * JSON is the normal way to drive a dispatch by hand. Both snake_case and
 * lowerCamel arm names are read: protojson emits lowerCamel by default but can
 * be told to keep the proto field names, and a decoder that accepts only one of
 * them fails on a Task that is otherwise valid.
 *
 * `nullValue` yields no entry: a null is the absence of a value, and rendering
 * it as the string "null" would hand a task a target id of `"null"`.
 */
export function typedValueString(val: unknown): string | undefined {
  if (typeof val === "string") return val
  if (!val || typeof val !== "object") return undefined
  const v = val as Record<string, unknown>
  const arm = <T>(camel: string, snake: string): T | undefined =>
    (v[camel] !== undefined ? v[camel] : v[snake]) as T | undefined

  const s = arm<unknown>("stringValue", "string_value")
  if (typeof s === "string") return s
  // protojson renders int64 and uint64 as strings, and double as a number.
  const i = arm<unknown>("intValue", "int_value")
  if (typeof i === "string" || typeof i === "number") return String(i)
  const u = arm<unknown>("uintValue", "uint_value")
  if (typeof u === "string" || typeof u === "number") return String(u)
  const d = arm<unknown>("doubleValue", "double_value")
  if (typeof d === "number") return String(d)
  const b = arm<unknown>("boolValue", "bool_value")
  if (typeof b === "boolean") return String(b)
  return undefined
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
 * Read one sandboxed dispatch's context from the environment.
 *
 * Deliberately never reads `GIBSON_BOOTSTRAP_TOKEN` or a host key: a sandboxed
 * run is authenticated by its per-dispatch grant alone, and reaching for a
 * bootstrap token here would reintroduce the enrollment handshake this shape
 * exists to avoid.
 *
 * The grant and the goal are required. A missing piece throws with the reason,
 * because a sandbox that launched this process without them is a defect in the
 * launch, not something to guess around by running opencode with no task or by
 * making unauthenticated calls.
 */
export function readDispatchContext(
  env: NodeJS.ProcessEnv,
  opts: { cwd?: string } = {},
): DispatchContext {
  const endpoint = env.GIBSON_CALLBACK_ENDPOINT
  const token = env.GIBSON_CG_JWT
  if (!endpoint) {
    throw new Error(
      "GIBSON_CALLBACK_ENDPOINT is not set. A sandboxed dispatched run is authenticated by " +
        "the per-dispatch grant the sandbox launch injects, not by a bootstrap token — the " +
        "launch must supply the callback endpoint and the grant.",
    )
  }
  if (!token) {
    throw new Error(
      "GIBSON_CALLBACK_ENDPOINT is set but GIBSON_CG_JWT is not. The callbacks would have no " +
        "grant to authenticate with; a sandboxed run must not fall back to any other identity, " +
        "so this fails instead.",
    )
  }
  const task = decodeTask(env.GIBSON_AGENT_TASK_B64)

  const timeoutRaw = env.GIBSON_TIMEOUT_MS ? Number(env.GIBSON_TIMEOUT_MS) : 0
  return {
    callbackEndpoint: endpoint,
    callbackToken: token,
    insecure: env.GIBSON_CALLBACK_INSECURE === "1",
    missionRunId: env.GIBSON_MISSION_RUN_ID ?? "",
    agentRunId: env.GIBSON_AGENT_RUN_ID ?? "",
    traceId: env.GIBSON_TRACE_ID ?? "",
    goal: task.goal,
    taskContext: task.context,
    ...(env.GIBSON_MISSION_ID ? { missionId: env.GIBSON_MISSION_ID } : {}),
    workspace: env.ZEROCOOL_WORKSPACE ?? opts.cwd ?? process.cwd(),
    ...(env.GIBSON_MODEL ? { model: env.GIBSON_MODEL } : {}),
    ...(env.GIBSON_OPENCODE_SESSION_ID ? { sessionId: env.GIBSON_OPENCODE_SESSION_ID } : {}),
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 0,
  }
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
  /** Opens the task harness. Defaults to `openTaskHarness` on the dispatch grant. */
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
    env: dispatchChildEnv(ctx),
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
      : (deps.harness ?? ((c: DispatchContext) => openTaskHarness({ endpoint: c.callbackEndpoint, token: c.callbackToken, insecure: c.insecure ?? false })))(ctx)
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
  const harness: TaskHarness | undefined = needsHarness
    ? (deps.harness ??
        ((c: DispatchContext) =>
          openTaskHarness({ endpoint: c.callbackEndpoint, token: c.callbackToken, insecure: c.insecure ?? false })))(ctx)
    : undefined

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
  const harness: TaskHarness | undefined = needsHarness
    ? (deps.harness ??
        ((c: DispatchContext) =>
          openTaskHarness({ endpoint: c.callbackEndpoint, token: c.callbackToken, insecure: c.insecure ?? false })))(ctx)
    : undefined

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
