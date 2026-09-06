// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Deliverable, JobSpec, JobState, Verdict } from "./job.js"

/**
 * The seams between the driver and the daemon. Interfaces only.
 *
 * The wire types live in `gibson.job.v1` (zeroroot-ai/sdk#545, published by
 * sdk#549). Until that tag lands, the driver is written against these shapes
 * and tested with in-memory fakes. The real implementations over the SDK
 * clients land in zerocool-plugins#105 and #108. Nothing here names a proto.
 */

/**
 * What a member receives. Nothing arrives as a bare string (glossary, Job).
 *
 * The names follow the wire: `open` is `OpenJob`, `close` is `CloseJob`, and
 * `turn`, `answer` and `wrap_up` are the arms of `gibson.job.v1.InputKind`
 * (`TURN`, `ANSWER`, `WRAP_UP`), lower-cased.
 */
export type JobInputKind =
  /** The first structured input. Opens the job. Carries the spec. */
  | "open"
  /** A later message on an open job: the verifier's report, a person's note. */
  | "turn"
  /** The answer to a question the job asked through `ask`. */
  | "answer"
  /** The last turn before the cleanup: commit, summarize. */
  | "wrap_up"
  /** The scorer closed the job. The driver runs the wrap-up turn, then cleans up. */
  | "close"

export interface JobInput {
  jobId: string
  kind: JobInputKind
  /** The turn's text. Empty on `close`. */
  text: string
  /** The per-turn task grant of this input's own dispatch (glossary, Per-turn grant). */
  grant: string
  /** Who sent it, for the console line. */
  sender: string
  spec?: JobSpec
  /**
   * Set on `open` when the daemon already knows the job's Claude Code
   * session: a member relaunched after a sandbox death. The driver restores
   * the transcript from the session store and resumes it.
   */
  claudeSessionId?: string
  /** Set on `close` and `wrap_up`. */
  verdict?: Verdict
  score?: number
}

/** What the driver reports per job. */
export interface JobStateReport {
  jobId: string
  state: JobState
  claudeSessionId: string
  turns: number
  costUsd: number
  /** The turn ended badly: an error result, or no result at all. */
  isError: boolean
  /** One line for the console: the result text, or why the turn ended. */
  detail: string
}

export interface DeliverableReport {
  jobId: string
  repository: string
  deliverable: Deliverable
  branch: string
  /** Commits pushed, when the deliverable pushed. */
  commits: number
  /** The merge request URL, when one was opened. */
  mergeRequestUrl: string
  /** Set when the deliverable was not performed. */
  error: string
}

/** The inbox: the daemon-owned queue this member pulls from (epic decision 6). */
export interface Inbox {
  /**
   * Long-lived subscription for inputs to jobs this member holds. The handler
   * runs once per input, in order. Resolves when `signal` aborts.
   */
  subscribe(onInput: (input: JobInput) => Promise<void>, signal: AbortSignal): Promise<void>
  /** Pull the next queued job for the bank. `undefined` when the queue is empty. */
  pull(): Promise<JobInput | undefined>
  reportState(report: JobStateReport): Promise<void>
  reportDeliverable(report: DeliverableReport): Promise<void>
}

/** Where a turn's grant comes from. */
export interface GrantSource {
  /** The member base grant. Clone, fetch, push, heartbeat, `GetCredential`. */
  baseGrant(): string
  /** The grant a turn runs under. The input's own, and the base grant when it carries none. */
  grantFor(input: JobInput): string
}

/**
 * What a member reports on every heartbeat. One value per arm of
 * `gibson.bank.v1.MemberState` (`LAUNCHING`, `NEEDS_SIGN_IN`, `IDLE`, `BUSY`,
 * `DRAINING`, `DEAD`), lower-cased. `dead` is never reported by the member
 * itself: the daemon decides it when the heartbeats stop.
 */
export type MemberState = "launching" | "needs_sign_in" | "idle" | "busy" | "draining" | "dead"

export interface MemberStatus {
  memberId: string
  bankId: string
  state: MemberState
  jobsInFlight: number
  cap: number
  /** Job ids, live ones. */
  jobs: string[]
  claudeCodeVersion: string
  /**
   * Days until the subscription login expires, when Claude Code warned about
   * it. `-1` when it did not. The state stays `idle` or `busy`: an expiring
   * login still works, and `MemberState` has no arm for it.
   */
  signInExpiresInDays: number
}

/** The heartbeat (glossary, Member status). */
export interface StatusReporter {
  reportStatus(status: MemberStatus): Promise<void>
}

/**
 * The localhost Gibson MCP server the turns attach to (#108).
 *
 * Both calls are awaited: the grant must be in force before the model can
 * make its first tool call, and dropped before the next turn starts.
 */
export interface McpGateway {
  /** The streamable HTTP URL, e.g. `http://127.0.0.1:7455/mcp`. */
  url: string
  /** Put this job's grant in force for the turn about to run. */
  useGrant(jobId: string, grant: string): Promise<void>
  /** The job's turn ended. The server falls back to the base grant. */
  release(jobId: string): Promise<void>
}

/** A grant source with the base grant only. Inputs carry their own or fall back. */
export function staticGrants(baseGrant: string): GrantSource {
  return {
    baseGrant: () => baseGrant,
    grantFor: (input) => input.grant || baseGrant,
  }
}

/** What the member reports, given what it is doing. */
export interface MemberStateInputs {
  inFlight: number
  cap: number
  needsSignIn: boolean
  /** The driver has started but has not finished reading its table yet. */
  launching: boolean
  /** A stop is in progress: the member finishes its turns and takes no more. */
  draining: boolean
}

/** The member state the heartbeat derives. Order is precedence. */
export function memberState(inputs: MemberStateInputs): MemberState {
  if (inputs.launching) return "launching"
  if (inputs.needsSignIn) return "needs_sign_in"
  if (inputs.draining) return "draining"
  return inputs.inFlight >= inputs.cap ? "busy" : "idle"
}
