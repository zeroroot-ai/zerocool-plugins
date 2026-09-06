// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { readSandboxDispatch, type SandboxDispatch } from "@zeroroot-ai/sdk"
import type { MemberEnv } from "./env.js"
import type { DeliverableReport, GrantSource, Inbox, JobInput, JobStateReport, MemberStatus, StatusReporter } from "./inbox.js"
import type { Deliverable, JobRepository, JobSpec } from "./job.js"

/**
 * The one-shot dispatch, run through the member driver (zerocool-plugins#111,
 * epic decision 5, ADR-0027 no parallel paths).
 *
 * gibson launches the image once per mission run with the task, the
 * per-dispatch grant and the callback endpoint in the environment. That
 * dispatch becomes exactly one job: the driver opens it, runs one turn, and
 * closes it itself, because there is no scorer in this shape. The dispatch is
 * the close. The verdict is `pass` when the turn's `result` says
 * `is_error: false`, and `fail` otherwise.
 *
 * There is one turn runner, one workspace manager and one job table for both
 * shapes. The only difference is the inbox: a member pulls from the daemon, a
 * one-shot pulls its single job from the launch.
 */

/**
 * Read one `Task.context` entry as a string.
 *
 * `Task.context` is `map<string, gibson.common.v1.TypedValue>`. The SDK parses
 * the launcher's protojson with the generated schema, so a value arrives as
 * the protobuf-es oneof shape, `{kind: {case: "stringValue", value: "..."}}`.
 * The raw protojson shape, `{"stringValue":"..."}`, is read too, because a
 * hand-built Task written as plain JSON is how a dispatch is driven by hand.
 * A decoder that keeps only plain strings drops every key, which is the bug
 * the opencode dispatch hit.
 *
 * A null yields no entry: a null is the absence of a value, and rendering it
 * as the string "null" would hand a task a repository url of `"null"`.
 */
export function typedValueString(val: unknown): string | undefined {
  if (typeof val === "string") return val
  if (!val || typeof val !== "object") return undefined
  const v = val as Record<string, unknown>

  // The parsed message: one `kind` oneof with a case and a value.
  const kind = v.kind as { case?: string; value?: unknown } | undefined
  if (kind && typeof kind === "object" && typeof kind.case === "string") {
    return armString(kind.case, kind.value)
  }

  // Raw protojson: one key naming the arm, in lowerCamel or snake_case.
  for (const [key, raw] of Object.entries(v)) {
    const s = armString(key, raw)
    if (s !== undefined) return s
  }
  return undefined
}

function armString(arm: string, raw: unknown): string | undefined {
  switch (arm) {
    case "stringValue":
    case "string_value":
      return typeof raw === "string" ? raw : undefined
    case "intValue":
    case "int_value":
    case "uintValue":
    case "uint_value":
      // protojson renders int64 and uint64 as strings; the parsed message
      // holds a bigint.
      return typeof raw === "string" || typeof raw === "number" || typeof raw === "bigint" ? String(raw) : undefined
    case "doubleValue":
    case "double_value":
      return typeof raw === "number" ? String(raw) : undefined
    case "boolValue":
    case "bool_value":
      return typeof raw === "boolean" ? String(raw) : undefined
    default:
      // nullValue, bytesValue and anything a later version adds: no string.
      return undefined
  }
}

/** The whole context map as strings. Entries with no readable value are dropped. */
export function taskContextStrings(context: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(context ?? {})) {
    const s = typedValueString(v)
    if (s !== undefined) out[k] = s
  }
  return out
}

function deliverableFrom(value: string | undefined): Deliverable {
  if (value === "MERGE_REQUEST" || value === "merge_request") return "MERGE_REQUEST"
  if (value === "PUSH_BRANCH" || value === "push_branch") return "PUSH_BRANCH"
  return "NONE"
}

/**
 * The job a dispatch asks for.
 *
 * A structured `JobSpec` on the Task is the shape the epic settles on
 * (zeroroot-ai/sdk#546). Until that field is published, a dispatch says the
 * same thing in the Task context, with the keys the opencode dispatch already
 * uses: `repository.url`, `repository.branch`, `repository.name`,
 * `repository.credential`, `repository.connector`, `repository.deliverable`,
 * `credentials` (a comma-separated list) and `acceptance`.
 */
export function jobSpecFromDispatch(d: SandboxDispatch, env: MemberEnv): JobSpec {
  const ctx = taskContextStrings((d.task as unknown as { context?: Record<string, unknown> }).context ?? {})
  const repositories: JobRepository[] = []
  const url = ctx["repository.url"] ?? ""
  if (url) {
    repositories.push({
      name: ctx["repository.name"] || url.replace(/\.git$/, "").split("/").pop() || "repo",
      connectorRef: ctx["repository.connector"] || "gitlab/default",
      cloneUrl: url,
      baseBranch: ctx["repository.branch"] || "main",
      deliverable: deliverableFrom(ctx["repository.deliverable"]),
      credentialName: ctx["repository.credential"] || ctx["gitlab.credential"] || "gitlab-token",
    })
  }
  const credentialNames = (ctx.credentials ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const r of repositories) if (!credentialNames.includes(r.credentialName)) credentialNames.push(r.credentialName)

  const constraints: JobSpec["constraints"] = {}
  const taskMaxTurns = (d.task as unknown as { constraints?: { maxTurns?: number } }).constraints?.maxTurns ?? 0
  if (taskMaxTurns > 0) constraints.maxTurns = taskMaxTurns
  if (env.maxBudgetUsd) constraints.maxBudgetUsd = env.maxBudgetUsd

  return {
    jobId: d.agentRunId || d.missionRunId || d.missionId || "one-shot",
    goal: d.goal,
    repositories,
    credentialNames,
    inputNodeIds: (ctx["input.nodes"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    acceptance: ctx.acceptance ?? "",
    constraints,
  }
}

/**
 * The inbox of a one-shot run. It holds one job, closes it when its turn ends,
 * and reports `done` when the driver finished the cleanup.
 */
export class OneShotInbox implements Inbox {
  private handler: ((i: JobInput) => Promise<void>) | undefined
  private pulled = false
  private closed = false
  private resolveDone!: (r: OneShotOutcome) => void
  readonly done: Promise<OneShotOutcome>
  readonly states: JobStateReport[] = []
  readonly deliverables: DeliverableReport[] = []

  constructor(
    private readonly spec: JobSpec,
    private readonly grant: string,
    private readonly sender: string,
  ) {
    this.done = new Promise<OneShotOutcome>((r) => (this.resolveDone = r))
  }

  async subscribe(onInput: (i: JobInput) => Promise<void>, signal: AbortSignal): Promise<void> {
    this.handler = onInput
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener("abort", () => resolve(), { once: true })
    })
  }

  async pull(): Promise<JobInput | undefined> {
    if (this.pulled) return undefined
    this.pulled = true
    return { jobId: this.spec.jobId, kind: "open", text: "", grant: this.grant, sender: this.sender, spec: this.spec }
  }

  async reportState(report: JobStateReport): Promise<void> {
    this.states.push(report)
    if (report.state === "waiting" && !this.closed) {
      // No scorer in this shape: the dispatch itself is the close.
      this.closed = true
      await this.handler?.({
        jobId: report.jobId,
        kind: "close",
        text: report.detail,
        grant: this.grant,
        sender: this.sender,
        verdict: report.isError ? "failed" : "accomplished",
        score: report.isError ? 0 : 100,
      })
      return
    }
    if (report.state === "closed") {
      this.resolveDone({
        jobId: report.jobId,
        isError: this.states.some((s) => s.state === "waiting" && s.isError),
        text: this.states.find((s) => s.state === "waiting")?.detail ?? "",
        claudeSessionId: report.claudeSessionId,
        costUsd: report.costUsd,
        turns: report.turns,
        deliverables: [...this.deliverables],
      })
    }
  }

  async reportDeliverable(report: DeliverableReport): Promise<void> {
    this.deliverables.push(report)
  }
}

export interface OneShotOutcome {
  jobId: string
  isError: boolean
  text: string
  claudeSessionId: string
  costUsd: number
  turns: number
  deliverables: DeliverableReport[]
}

/** The status seam of a one-shot run: there is no bank to heartbeat. */
export class OneShotStatus implements StatusReporter {
  readonly reports: MemberStatus[] = []
  async reportStatus(s: MemberStatus): Promise<void> {
    this.reports.push(s)
  }
}

/** The dispatch grant is both the member base grant and the turn grant. */
export function dispatchGrants(grant: string): GrantSource {
  return { baseGrant: () => grant, grantFor: () => grant }
}

/** The member environment a one-shot launch implies. */
export function oneShotMemberEnv(d: SandboxDispatch, env: NodeJS.ProcessEnv, read: (e: NodeJS.ProcessEnv) => MemberEnv): MemberEnv {
  return read({
    ...env,
    GIBSON_MEMBER_ID: env.GIBSON_MEMBER_ID || d.agentRunId || "one-shot",
    GIBSON_BANK_ID: env.GIBSON_BANK_ID || "one-shot",
    GIBSON_INSTANCE_MODE: "one-shot",
    ZEROCOOL_JOB_CAP: "1",
    ...(d.model ? { ZEROCOOL_CLAUDE_MODEL: d.model } : {}),
  })
}

/** Read the launch. Exported so the bin stays three lines. */
export function readDispatch(env: NodeJS.ProcessEnv): SandboxDispatch {
  return readSandboxDispatch(env)
}
