// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * The job table (glossary, Job). A job is the unit of work a member holds:
 * one persistent Claude Code session, its worktrees, and a state.
 *
 *   open ──startTurn──▶ working ──finishTurn──▶ waiting
 *     │                    │                       │
 *     │                    └──(interrupted)──▶ waiting ──startTurn──▶ working
 *     │                                            │
 *     └────────────────── close / abandon ─────────┴──▶ closed
 *
 * The worker never closes its own job (glossary, Close). `close` is what a
 * scorer's `CloseJob` becomes once the driver ran the wrap-up turn. `abandon`
 * is the stale-limit path and closes with verdict `abandoned`. A turn cannot
 * start while the cap is reached, and a job that is `working` cannot close:
 * the driver interrupts the turn first.
 *
 * The table persists to `<stateDir>/jobs.json` so a driver restart inside the
 * same sandbox recovers. A job found `working` at load was mid-turn when the
 * driver died. It comes back `waiting` and flagged `recovered`, so the next
 * input resumes the Claude Code session from its transcript on disk.
 */
export type JobState = "open" | "working" | "waiting" | "closed"

/**
 * What a scorer decides. One value per arm of `gibson.job.v1.JobVerdict`
 * (`ACCOMPLISHED`, `FAILED`, `ABANDONED`), lower-cased. `abandoned` is the
 * stale-limit path the driver takes on its own.
 */
export type Verdict = "accomplished" | "failed" | "abandoned"

export interface JobRepository {
  /** Short name, also the worktree directory name under the job. */
  name: string
  /** Connector reference, e.g. `gitlab/acme`. The clone cache is keyed by it. */
  connectorRef: string
  cloneUrl: string
  baseBranch: string
  /** What the driver does at wrap-up. */
  deliverable: Deliverable
  /** The credential name `GetCredential` resolves the git token from. */
  credentialName: string
  /** The HTTP basic username the token pairs with. Default `oauth2`. */
  gitUsername?: string
}

/** The outward side effect the driver performs for a repository at wrap-up. */
export type Deliverable = "NONE" | "PUSH_BRANCH" | "MERGE_REQUEST"

export interface JobSpec {
  jobId: string
  goal: string
  repositories: JobRepository[]
  /** Credential names the turn may fetch through `get_credential`. */
  credentialNames: string[]
  /** World node ids the job reads as input. */
  inputNodeIds: string[]
  acceptance: string
  constraints: {
    maxTurns?: number
    maxBudgetUsd?: number
  }
}

export interface JobClosure {
  verdict: Verdict
  score: number
  at: number
  /** Free text from the scorer or the driver. */
  note: string
}

export interface JobRecord {
  jobId: string
  state: JobState
  spec: JobSpec
  /** Claude Code's session id, captured from `system/init` on the first turn. */
  claudeSessionId: string
  /** Repository name to worktree path. */
  worktrees: Record<string, string>
  openedAt: number
  /** Last time an input arrived or a turn ended. The stale clock. */
  lastActivityAt: number
  turns: number
  costUsd: number
  /** Set when the driver died mid-turn and the job came back at load. */
  recovered: boolean
  closure?: JobClosure
}

export class JobError extends Error {
  constructor(
    readonly code: "not_found" | "bad_state" | "cap_reached" | "duplicate",
    message: string,
  ) {
    super(message)
    this.name = "JobError"
  }
}

export interface JobStore {
  load(): Promise<JobRecord[]>
  save(records: JobRecord[]): Promise<void>
}

/** `jobs.json`, written atomically (tmp then rename), mode 0600. */
export class FileJobStore implements JobStore {
  constructor(readonly path: string) {}

  async load(): Promise<JobRecord[]> {
    let raw: string
    try {
      raw = await readFile(this.path, "utf8")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
      throw e
    }
    const parsed = JSON.parse(raw) as { jobs?: unknown }
    if (!parsed || !Array.isArray(parsed.jobs)) throw new Error(`${this.path}: not a job table`)
    return parsed.jobs as JobRecord[]
  }

  async save(records: JobRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify({ version: 1, jobs: records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(tmp, this.path)
  }
}

/** A store that keeps nothing. For tests and the one-shot shape. */
export class MemoryJobStore implements JobStore {
  records: JobRecord[] = []
  async load(): Promise<JobRecord[]> {
    return structuredClone(this.records)
  }
  async save(records: JobRecord[]): Promise<void> {
    this.records = structuredClone(records)
  }
}

export interface JobTableOptions {
  cap: number
  store: JobStore
  clock?: () => number
}

export class JobTable {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly clock: () => number
  readonly cap: number
  private readonly store: JobStore

  constructor(opts: JobTableOptions) {
    if (!Number.isInteger(opts.cap) || opts.cap <= 0) throw new Error(`job cap must be a positive integer, got ${opts.cap}`)
    this.cap = opts.cap
    this.store = opts.store
    this.clock = opts.clock ?? Date.now
  }

  /** Load the table. Returns the ids of jobs recovered from a mid-turn death. */
  async load(): Promise<string[]> {
    const recovered: string[] = []
    for (const r of await this.store.load()) {
      if (r.state === "working") {
        r.state = "waiting"
        r.recovered = true
        recovered.push(r.jobId)
      }
      this.jobs.set(r.jobId, r)
    }
    if (recovered.length > 0) await this.persist()
    return recovered
  }

  private async persist(): Promise<void> {
    await this.store.save([...this.jobs.values()])
  }

  get(jobId: string): JobRecord {
    const r = this.jobs.get(jobId)
    if (!r) throw new JobError("not_found", `job ${jobId} is not in the table`)
    return r
  }

  has(jobId: string): boolean {
    return this.jobs.has(jobId)
  }

  list(): JobRecord[] {
    return [...this.jobs.values()]
  }

  /** Jobs that are not closed. */
  live(): JobRecord[] {
    return this.list().filter((r) => r.state !== "closed")
  }

  get inFlight(): number {
    return this.list().filter((r) => r.state === "working").length
  }

  get freeSlots(): number {
    return Math.max(0, this.cap - this.inFlight)
  }

  /** Repository connector refs some live job uses. Eviction must skip them. */
  connectorRefsInUse(): Set<string> {
    const refs = new Set<string>()
    for (const r of this.live()) for (const repo of r.spec.repositories) refs.add(repo.connectorRef)
    return refs
  }

  async open(spec: JobSpec): Promise<JobRecord> {
    if (this.jobs.has(spec.jobId)) throw new JobError("duplicate", `job ${spec.jobId} is already in the table`)
    const now = this.clock()
    const r: JobRecord = {
      jobId: spec.jobId,
      state: "open",
      spec,
      claudeSessionId: "",
      worktrees: {},
      openedAt: now,
      lastActivityAt: now,
      turns: 0,
      costUsd: 0,
      recovered: false,
    }
    this.jobs.set(spec.jobId, r)
    await this.persist()
    return r
  }

  /** A relaunched member learns the session id from the daemon before any turn. */
  async setClaudeSessionId(jobId: string, claudeSessionId: string): Promise<void> {
    this.get(jobId).claudeSessionId = claudeSessionId
    await this.persist()
  }

  async setWorktrees(jobId: string, worktrees: Record<string, string>): Promise<void> {
    this.get(jobId).worktrees = { ...worktrees }
    await this.persist()
  }

  /** `open` or `waiting` becomes `working`. Refused at the cap. */
  async startTurn(jobId: string): Promise<JobRecord> {
    const r = this.get(jobId)
    if (r.state !== "open" && r.state !== "waiting") throw new JobError("bad_state", `job ${jobId} is ${r.state}, a turn needs open or waiting`)
    if (this.freeSlots === 0) throw new JobError("cap_reached", `job ${jobId} cannot start: ${this.inFlight} of ${this.cap} slots in use`)
    r.state = "working"
    r.recovered = false
    r.lastActivityAt = this.clock()
    await this.persist()
    return r
  }

  /** `working` becomes `waiting`. Records the session id and the cost. */
  async finishTurn(jobId: string, outcome: { claudeSessionId?: string; costUsd: number; interrupted?: boolean }): Promise<JobRecord> {
    const r = this.get(jobId)
    if (r.state !== "working") throw new JobError("bad_state", `job ${jobId} is ${r.state}, only a working job finishes a turn`)
    r.state = "waiting"
    if (outcome.claudeSessionId) r.claudeSessionId = outcome.claudeSessionId
    r.turns += 1
    r.costUsd += outcome.costUsd
    r.recovered = outcome.interrupted === true
    r.lastActivityAt = this.clock()
    await this.persist()
    return r
  }

  /** An input arrived. Resets the stale clock. */
  async touch(jobId: string): Promise<void> {
    this.get(jobId).lastActivityAt = this.clock()
    await this.persist()
  }

  /** `open` or `waiting` becomes `closed` with the scorer's verdict. */
  async close(jobId: string, verdict: Verdict, score: number, note = ""): Promise<JobRecord> {
    const r = this.get(jobId)
    if (r.state === "closed") throw new JobError("bad_state", `job ${jobId} is already closed`)
    if (r.state === "working") throw new JobError("bad_state", `job ${jobId} is working, interrupt the turn before closing`)
    r.state = "closed"
    r.closure = { verdict, score, at: this.clock(), note }
    await this.persist()
    return r
  }

  /** Close every `waiting` or `open` job idle past `limitMs` as `abandoned`. */
  async abandonStale(limitMs: number): Promise<JobRecord[]> {
    const now = this.clock()
    const out: JobRecord[] = []
    for (const r of this.live()) {
      if (r.state === "working") continue
      if (now - r.lastActivityAt < limitMs) continue
      out.push(await this.close(r.jobId, "abandoned", 0, `idle for ${now - r.lastActivityAt}ms, past the stale limit of ${limitMs}ms`))
    }
    return out
  }

  /** Drop a closed job from the table after cleanup. */
  async drop(jobId: string): Promise<void> {
    const r = this.get(jobId)
    if (r.state !== "closed") throw new JobError("bad_state", `job ${jobId} is ${r.state}, only a closed job is dropped`)
    this.jobs.delete(jobId)
    await this.persist()
  }
}
