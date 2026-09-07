// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { TaskHarness } from "@zeroroot-ai/sdk"
import {
  DeliverableKind,
  InputKind,
  JobState as WireJobState,
  type Input as WireInput,
  type Job as WireJob,
  type JobSpec as WireJobSpec,
  type RepositorySpec,
} from "@zeroroot-ai/sdk/gen/gibson/job/v1/job_pb.js"
import { Principal_Kind, type Principal } from "@zeroroot-ai/sdk/gen/gibson/common/v1/gibson_common_pb.js"
import type { DeliverableReport, GrantSource, Inbox, JobInput, JobInputKind, JobStateReport } from "./inbox.js"
import type { Deliverable, JobRepository, JobSpec, JobState } from "./job.js"
import { trimLeadingSlashes, trimTrailingSlashes } from "./text.js"

/**
 * The member inbox over the harness (zerocool-plugins#105, epic decision 6).
 *
 * Input to a long-lived member is one daemon-owned inbox, pulled outbound by
 * the sandbox: the member subscribes and the daemon streams messages down it.
 * The sandbox never accepts an inbound connection, so setec `Attach` is not
 * used and no port is opened.
 *
 * The subscription is a lifetime RPC and runs under the member base grant.
 * Each message carries the grant of its own dispatch, which the driver puts in
 * force for that turn. The stream is reconnected with backoff until the member
 * stops: a dropped subscription is a member that stops receiving work, not a
 * member that should die.
 */
export const MIN_BACKOFF_MS = 500
export const MAX_BACKOFF_MS = 30_000

/** The next backoff, doubling to the cap. */
export function nextBackoff(previous: number): number {
  return previous <= 0 ? MIN_BACKOFF_MS : Math.min(previous * 2, MAX_BACKOFF_MS)
}

/** `gibson.job.v1.InputKind` to the driver's word for it. */
export function inputKindOf(kind: InputKind): JobInputKind {
  switch (kind) {
    case InputKind.ANSWER:
      return "answer"
    case InputKind.WRAP_UP:
      return "wrap_up"
    default:
      // TURN and UNSPECIFIED are both a turn: a message with no kind is the
      // ordinary case, and refusing it would drop a person's input.
      return "turn"
  }
}

/** A `gibson.common.v1.Principal` as one readable line for the console. */
export function senderOf(p: Principal | undefined): string {
  if (!p) return "unknown"
  const kind = Principal_Kind[p.kind] ?? "UNSPECIFIED"
  return `${kind.toLowerCase()}:${p.id || "-"}`
}

function deliverableKindOf(kind: DeliverableKind): Deliverable {
  switch (kind) {
    case DeliverableKind.PUSH_BRANCH:
      return "PUSH_BRANCH"
    case DeliverableKind.MERGE_REQUEST:
      return "MERGE_REQUEST"
    default:
      return "NONE"
  }
}

function wireDeliverableKind(d: Deliverable): DeliverableKind {
  switch (d) {
    case "PUSH_BRANCH":
      return DeliverableKind.PUSH_BRANCH
    case "MERGE_REQUEST":
      return DeliverableKind.MERGE_REQUEST
    default:
      return DeliverableKind.NONE
  }
}

/** The driver's job state as the wire enum. */
export function wireJobState(state: JobState): WireJobState {
  switch (state) {
    case "open":
      return WireJobState.OPEN
    case "working":
      return WireJobState.WORKING
    case "waiting":
      return WireJobState.WAITING
    default:
      return WireJobState.CLOSED
  }
}

/**
 * `gibson.job.v1.RepositorySpec` to what the workspace manager needs.
 *
 * `project` is the connector's own project reference, for example
 * `group/project` on GitLab. The clone url is built from the connector's base
 * url, which the driver resolves through the connector credential name. When
 * the project is already a url, it is used as it stands.
 */
export function repositoryOf(r: RepositorySpec, credentialName: string, connectorBaseUrl: string): JobRepository {
  const project = trimLeadingSlashes(r.project)
  const isUrl = project.startsWith("https://") || project.startsWith("http://")
  const cloneUrl = isUrl ? project : `${trimTrailingSlashes(connectorBaseUrl)}/${project}.git`
  return {
    name: r.name || project.split("/").pop() || "repo",
    connectorRef: r.connectorRef,
    cloneUrl,
    baseBranch: r.baseBranch || "main",
    deliverable: deliverableKindOf(r.deliverable),
    credentialName,
  }
}

export interface SpecOptions {
  /** The credential name a repository's connector resolves to. */
  credentialFor: (connectorRef: string, spec: WireJobSpec) => string
  /** The connector's base url, for repositories named by project rather than url. */
  baseUrlFor: (connectorRef: string, spec: WireJobSpec) => string
}

/** `gibson.job.v1.JobSpec` to the driver's spec. */
export function jobSpecOf(jobId: string, spec: WireJobSpec | undefined, opts: SpecOptions): JobSpec {
  const wire = spec ?? ({ goal: "", repositories: [], credentialNames: [], inputs: [], context: {} } as unknown as WireJobSpec)
  return {
    jobId,
    goal: wire.goal,
    repositories: (wire.repositories ?? []).map((r) => repositoryOf(r, opts.credentialFor(r.connectorRef, wire), opts.baseUrlFor(r.connectorRef, wire))),
    credentialNames: [...(wire.credentialNames ?? [])],
    inputNodeIds: [...(wire.inputs ?? [])],
    acceptance: wire.acceptance ? `${wire.acceptance.verifierComponent} must score at least ${wire.acceptance.passingScore}` : "",
    constraints: {},
  }
}

/** One inbox message as the driver reads it. */
export function jobInputOf(input: WireInput): JobInput {
  return {
    jobId: input.jobId,
    kind: inputKindOf(input.kind),
    text: input.message,
    grant: input.grant,
    sender: senderOf(input.sender),
  }
}

/** A queued job the member pulled, as the `open` input that starts it. */
export function openInputOf(job: WireJob, baseGrant: string, opts: SpecOptions): JobInput {
  return {
    jobId: job.id,
    kind: "open",
    text: "",
    // A pulled job carries no per-input grant: the first turn runs under the
    // member base grant until an input of its own arrives.
    grant: baseGrant,
    sender: senderOf(job.openedBy),
    spec: jobSpecOf(job.id, job.spec, opts),
    ...(job.claudeSessionId ? { claudeSessionId: job.claudeSessionId } : {}),
  }
}

export interface HarnessInboxOptions {
  harness: TaskHarness
  /** The member this inbox serves. Reported on every call. */
  memberId: string
  spec: SpecOptions
  log?: (line: string) => void
  /** Test seam for the reconnect delay. */
  sleep?: (ms: number) => Promise<void>
}

/** The inbox, the queue and the reports, over `HarnessCallbackService`. */
export class HarnessInbox implements Inbox {
  private readonly log: (line: string) => void
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: HarnessInboxOptions) {
    this.log = opts.log ?? (() => {})
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  private get client() {
    return this.opts.harness.client
  }

  private get context() {
    return this.opts.harness.context
  }

  /** Subscribe until `signal` aborts, reconnecting with backoff. */
  async subscribe(onInput: (input: JobInput) => Promise<void>, signal: AbortSignal): Promise<void> {
    let backoff = 0
    while (!signal.aborted) {
      try {
        for await (const res of this.client.subscribeInput({ context: this.context }, { signal })) {
          backoff = 0
          if (!res.input) continue
          await onInput(jobInputOf(res.input))
        }
        // A clean end of stream is the daemon closing it. Reconnect.
      } catch (e) {
        if (signal.aborted) return
        this.log(`inbox: subscription failed: ${(e as Error).message}`)
      }
      if (signal.aborted) return
      backoff = nextBackoff(backoff)
      await this.sleep(backoff)
    }
  }

  /** The next queued job of this member's bank, or nothing. */
  async pull(): Promise<JobInput | undefined> {
    const res = await this.client.pullJob({ context: this.context })
    if (res.error) throw new Error(`PullJob refused: ${res.error.message}`)
    if (!res.job) return undefined
    return openInputOf(res.job, this.opts.harness.token(), this.opts.spec)
  }

  async reportState(report: JobStateReport): Promise<void> {
    const res = await this.client.reportJobState({
      context: this.context,
      jobId: report.jobId,
      state: wireJobState(report.state),
      claudeSessionId: report.claudeSessionId,
    })
    if (res.error) throw new Error(`ReportJobState(${report.jobId}) refused: ${res.error.message}`)
  }

  async reportDeliverable(report: DeliverableReport): Promise<void> {
    const res = await this.client.reportDeliverable({
      context: this.context,
      jobId: report.jobId,
      deliverable: {
        $typeName: "gibson.job.v1.Deliverable",
        kind: wireDeliverableKind(report.deliverable),
        ref: report.branch,
        url: report.mergeRequestUrl,
      },
    })
    if (res.error) throw new Error(`ReportDeliverable(${report.jobId}) refused: ${res.error.message}`)
  }
}

/**
 * The grants of a member. The base grant comes from the harness, which renews
 * it, so a member that runs for days never presents an expired one. A turn
 * uses the grant of its own input, and falls back to the base grant for an
 * input the daemon sent without one (a pulled job).
 */
export function harnessGrants(harness: TaskHarness): GrantSource {
  return {
    baseGrant: () => harness.token(),
    grantFor: (input) => input.grant || harness.token(),
  }
}
