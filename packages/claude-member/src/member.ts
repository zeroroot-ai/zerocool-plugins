// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { ClaudeRunResult } from "./claude-run.js"
import type { MemberEnv } from "./env.js"
import type { ClaudeEvent } from "./events.js"
import { memberState, type GrantSource, type Inbox, type JobInput, type McpGateway, type MemberStatus, type StatusReporter } from "./inbox.js"
import { JobError, JobTable, type JobRecord, type Verdict } from "./job.js"
import { parseExpiryWarning, type SignInRelay } from "./signin.js"
import { archiveTranscript, restoreTranscript, transcriptOnDisk, type SessionStore } from "./transcript.js"
import { startTurn, type TurnHandle } from "./turn.js"
import type { WorkspaceManager, Worktree } from "./workspace.js"

/**
 * The member driver loop (zerocool-plugins#105, glossary: Member, Job, Close).
 *
 *  1. Load the job table. Jobs found mid-turn come back `waiting`.
 *  2. Subscribe to the inbox for inputs to jobs this member holds.
 *  3. While a slot is free: run the oldest queued input on a held job, else
 *     pull the next queued job for the bank.
 *  4. Heartbeat the member status every `heartbeatMs`.
 *  5. On stop: interrupt running turns (SIGINT, so Claude Code records a
 *     result), persist, resolve.
 *
 * One process per active job, bounded by the cap. Idle jobs hold no process.
 */
export interface MemberDeps {
  env: MemberEnv
  processEnv: NodeJS.ProcessEnv
  table: JobTable
  inbox: Inbox
  grants: GrantSource
  status: StatusReporter
  workspace: WorkspaceManager
  mcp?: McpGateway
  claudeCodeVersion: string
  /** True when the login shape is `subscription` and no login is present. */
  needsSignIn?: () => boolean
  /** Where an expiring subscription login is reported (#109). */
  signInRelay?: SignInRelay
  /** Where transcripts are archived to and restored from (#107). */
  sessions?: SessionStore
  /** Grace for a turn to end after SIGINT before the member stops, ms. Default 30s. */
  stopGraceMs?: number
  onEvent?: (jobId: string, line: string, event: ClaudeEvent | undefined) => void
  log?: (line: string) => void
  spawn?: Parameters<typeof startTurn>[1]["spawn"]
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">
  /** How long the pull loop sleeps when the queue is empty, ms. */
  idlePollMs?: number
}

/**
 * The last turn of a job (glossary, Close). The scorer's note, when it sent
 * one, comes first, so Claude knows what the verdict was.
 */
export function wrapUpPrompt(note: string): string {
  const lines = [
    "This job is being closed. This is your last turn.",
    "Commit your work on the job branch with a clear message. Do not push: the platform pushes at wrap-up.",
    "Then write a short summary of what you did, what you verified, and what remains.",
  ]
  if (note.trim()) lines.unshift(`From the scorer: ${note.trim()}`)
  return lines.join("\n")
}

export class Member {
  private readonly queue: JobInput[] = []
  private readonly running = new Map<string, TurnHandle>()
  /** Jobs whose next turn is the wrap-up: after it, the close runs. */
  private readonly closing = new Map<string, { verdict: Verdict; score: number; note: string }>()
  private readonly log: (line: string) => void
  private readonly timers: NonNullable<MemberDeps["timers"]>
  private wake: (() => void) | undefined
  private stopping = false
  /** The day an expiry warning was last reported, so it is reported once a day. */
  private expiryReportedOn = ""
  /** Days until the subscription login expires, as Claude Code last warned. */
  private signInExpiresInDays = -1
  /** True until the table is loaded, and again once a stop is in progress. */
  private launching = true

  constructor(private readonly deps: MemberDeps) {
    this.log = deps.log ?? (() => {})
    this.timers = deps.timers ?? globalThis
  }

  /** The heartbeat body. */
  status(): MemberStatus {
    const t = this.deps.table
    return {
      memberId: this.deps.env.memberId,
      bankId: this.deps.env.bankId,
      state: memberState({
        inFlight: t.inFlight,
        cap: t.cap,
        needsSignIn: this.deps.needsSignIn?.() ?? false,
        launching: this.launching,
        draining: this.stopping,
      }),
      jobsInFlight: t.inFlight,
      cap: t.cap,
      jobs: t.live().map((j) => j.jobId),
      claudeCodeVersion: this.deps.claudeCodeVersion,
      signInExpiresInDays: this.signInExpiresInDays,
    }
  }

  /** Run until `signal` aborts. Resolves after every turn ended and the table is saved. */
  async run(signal: AbortSignal): Promise<void> {
    const recovered = await this.deps.table.load()
    for (const id of recovered) this.log(`job ${id}: recovered from a mid-turn restart, waiting for the next input`)
    this.launching = false

    const heartbeat = this.timers.setInterval(() => {
      void this.deps.status.reportStatus(this.status()).catch((e: Error) => this.log(`heartbeat: ${e.message}`))
    }, this.deps.env.heartbeatMs)
    // The loop keeps the process alive; the heartbeat must not keep a dying one alive.
    ;(heartbeat as { unref?: () => void }).unref?.()
    await this.deps.status.reportStatus(this.status()).catch((e: Error) => this.log(`heartbeat: ${e.message}`))

    const subscription = this.deps.inbox.subscribe(async (input) => {
      this.enqueue(input)
    }, signal)

    const onAbort = () => {
      this.stopping = true
      for (const h of this.running.values()) h.interrupt()
      this.wake?.()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })

    try {
      while (!this.stopping) {
        await this.deps.table.abandonStale(this.deps.env.staleLimitMs).then((closed) => Promise.all(closed.map((j) => this.cleanupClosed(j, "abandoned"))))
        const started = await this.schedule()
        if (!started) await this.sleep(this.deps.idlePollMs ?? 1000, signal)
      }
      await this.drain()
    } finally {
      this.timers.clearInterval(heartbeat)
      await subscription.catch((e: Error) => this.log(`inbox: ${e.message}`))
    }
  }

  /**
   * Stop: the turns in flight were sent SIGINT by `onAbort`. Wait for them
   * up to the grace period, then archive every job with a session, so a
   * relaunched member can resume it, and tell the daemon the member stopped.
   */
  private async drain(): Promise<void> {
    const grace = this.deps.stopGraceMs ?? 30_000
    const pending = [...this.running.values()].map((h) => h.done)
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          const t = this.timers.setTimeout(() => resolve(), grace)
          ;(t as { unref?: () => void }).unref?.()
        }),
      ])
      for (const h of this.running.values()) h.kill()
      await Promise.allSettled(pending)
    }
    for (const job of this.deps.table.live()) {
      await this.archive(job)
      await this.report(job, "member stopping")
    }
  }

  /** Archive the job's transcript. Never fatal: the worktree and the session file are still on disk. */
  private async archive(job: JobRecord): Promise<void> {
    if (!this.deps.sessions || !job.claudeSessionId) return
    try {
      const manifest = await archiveTranscript({
        store: this.deps.sessions,
        jobId: job.jobId,
        configDir: this.deps.env.claudeConfigDir,
        cwd: this.cwdOf(job),
        sessionId: job.claudeSessionId,
      })
      if (manifest) this.log(`job ${job.jobId}: archived ${manifest.files.length} transcript file(s)`)
    } catch (e) {
      this.log(`job ${job.jobId}: archive failed: ${(e as Error).message}`)
    }
  }

  /**
   * A relaunched member holds a job whose transcript is gone with the old
   * sandbox. Put it back from the session store before the first turn, so
   * `--resume` finds the same session.
   */
  private async restore(job: JobRecord): Promise<void> {
    if (!this.deps.sessions) return
    if (job.claudeSessionId && (await transcriptOnDisk(this.deps.env.claudeConfigDir, this.cwdOf(job), job.claudeSessionId))) return
    try {
      const sessionId = await restoreTranscript({ store: this.deps.sessions, jobId: job.jobId, configDir: this.deps.env.claudeConfigDir })
      if (!sessionId) return
      if (sessionId !== job.claudeSessionId) await this.deps.table.setClaudeSessionId(job.jobId, sessionId)
      this.log(`job ${job.jobId}: transcript restored, resuming session ${sessionId}`)
    } catch (e) {
      this.log(`job ${job.jobId}: restore failed, the job starts a fresh session: ${(e as Error).message}`)
    }
  }

  private cwdOf(job: JobRecord): string {
    const first = job.spec.repositories[0]
    return (first && job.worktrees[first.name]) ?? this.deps.env.workspace
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const t = this.timers.setTimeout(() => {
        this.wake = undefined
        resolve()
      }, ms)
      this.wake = () => {
        this.timers.clearTimeout(t)
        this.wake = undefined
        resolve()
      }
    })
  }

  /** Inputs for held jobs queue in order. The loop drains them. */
  enqueue(input: JobInput): void {
    this.queue.push(input)
    this.wake?.()
  }

  /** Start at most one thing. Returns whether something started. */
  private async schedule(): Promise<boolean> {
    const table = this.deps.table
    // Inputs on held jobs first, oldest first, skipping jobs mid-turn.
    for (let i = 0; i < this.queue.length; i++) {
      const input = this.queue[i]!
      if (this.running.has(input.jobId)) continue
      if (input.kind === "close") {
        this.queue.splice(i, 1)
        await this.close(input)
        return true
      }
      if (input.kind === "wrap_up") {
        this.closing.set(input.jobId, { verdict: input.verdict ?? "accomplished", score: input.score ?? 0, note: input.text })
      }
      if (table.freeSlots === 0) return false
      this.queue.splice(i, 1)
      await this.turn(input)
      return true
    }
    if (table.freeSlots === 0) return false
    const pulled = await this.deps.inbox.pull()
    if (!pulled) return false
    await this.turn(pulled)
    return true
  }

  private async report(job: JobRecord, detail: string, isError = false): Promise<void> {
    await this.deps.inbox
      .reportState({ jobId: job.jobId, state: job.state, claudeSessionId: job.claudeSessionId, turns: job.turns, costUsd: job.costUsd, isError, detail })
      .catch((e: Error) => this.log(`job ${job.jobId}: reportState: ${e.message}`))
  }

  private async turn(input: JobInput): Promise<void> {
    const table = this.deps.table
    let job: JobRecord
    try {
      if (input.kind === "open") {
        if (!input.spec) throw new JobError("bad_state", `open input for ${input.jobId} carries no spec`)
        job = table.has(input.jobId) ? table.get(input.jobId) : await table.open(input.spec)
        if (input.claudeSessionId && !job.claudeSessionId) await table.setClaudeSessionId(job.jobId, input.claudeSessionId)
        await this.restore(job)
      } else {
        job = table.get(input.jobId)
        await table.touch(job.jobId)
      }
    } catch (e) {
      this.log(`job ${input.jobId}: ${(e as Error).message}`)
      return
    }
    let worktrees: Worktree[]
    try {
      worktrees = await this.deps.workspace.prepare(job.jobId, job.spec.repositories)
      await table.setWorktrees(job.jobId, Object.fromEntries(worktrees.map((w) => [w.repository, w.path])))
    } catch (e) {
      this.log(`job ${job.jobId}: workspace: ${(e as Error).message}`)
      await this.report(job, `workspace failed: ${(e as Error).message}`, true)
      return
    }
    await table.startTurn(job.jobId)
    await this.report(job, `turn ${job.turns + 1} started by ${input.sender}`)
    const cwd = worktrees[0]?.path ?? this.deps.env.workspace
    const text = input.kind === "open" ? job.spec.goal + (input.text ? `\n\n${input.text}` : "") : input.kind === "wrap_up" ? wrapUpPrompt(input.text) : input.text
    const handle = await startTurn(
      { job, text, grant: this.deps.grants.grantFor(input), worktrees, cwd },
      { env: this.deps.env, processEnv: this.deps.processEnv, mcp: this.deps.mcp, ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {}), ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}) },
    )
    this.running.set(job.jobId, handle)
    void handle.done
      .then((r) => this.finish(job.jobId, r))
      .catch((e: Error) => this.finish(job.jobId, { text: e.message, sessionId: "", isError: true, resultSubtype: "spawn_failed", numTurns: 0, costUsd: 0, mcpServerErrors: [], toolCalls: [], events: 0, sawResult: false, stderr: "", exitCode: null, signal: null }))
      .finally(() => {
        this.running.delete(job.jobId)
        this.wake?.()
      })
  }

  /** Claude Code warns on stderr when a subscription login is close to expiry. */
  private async reportExpiry(stderr: string): Promise<void> {
    const days = parseExpiryWarning(stderr)
    if (days < 0) return
    this.signInExpiresInDays = days
    const today = new Date(Date.now()).toISOString().slice(0, 10)
    if (this.expiryReportedOn === today) return
    this.expiryReportedOn = today
    await this.deps.signInRelay?.reportExpiring?.(days).catch((e: Error) => this.log(`sign-in expiry: ${e.message}`))
  }

  private async finish(jobId: string, r: ClaudeRunResult): Promise<void> {
    const table = this.deps.table
    await this.reportExpiry(r.stderr)
    const interrupted = !r.sawResult || r.signal !== null
    const job = await table.finishTurn(jobId, { claudeSessionId: r.sessionId, costUsd: r.costUsd, interrupted })
    const detail = r.sawResult ? (r.isError ? `turn ended with ${r.resultSubtype}: ${r.text.slice(0, 500)}` : r.text.slice(0, 500)) : `turn interrupted (exit ${r.exitCode ?? r.signal}): ${r.text.slice(0, 500)}`
    if (r.mcpServerErrors.length > 0) this.log(`job ${jobId}: MCP: ${r.mcpServerErrors.join("; ")}`)
    await this.report(job, detail, r.isError || !r.sawResult)
    const closing = this.closing.get(jobId)
    if (closing) {
      this.closing.delete(jobId)
      const closed = await table.close(jobId, closing.verdict, closing.score, closing.note || r.text.slice(0, 2000))
      await this.cleanupClosed(closed, closing.verdict)
    }
  }

  private async close(input: JobInput): Promise<void> {
    const table = this.deps.table
    if (!table.has(input.jobId)) {
      this.log(`close for unknown job ${input.jobId}`)
      return
    }
    const verdict = input.verdict ?? "accomplished"
    const job = await table.close(input.jobId, verdict, input.score ?? 0, input.text)
    await this.cleanupClosed(job, verdict)
  }

  private async cleanupClosed(job: JobRecord, verdict: string): Promise<void> {
    await this.archive(job)
    const push = verdict !== "abandoned"
    const outcomes = await this.deps.workspace.wrapUp(job.jobId, job.spec.repositories, {
      push,
      title: `job ${job.jobId}: ${job.spec.goal.slice(0, 72)}`,
      description: `${job.spec.goal}\n\nVerdict: ${verdict}. Turns: ${job.turns}. Cost: $${job.costUsd.toFixed(4)}.`,
    })
    for (const o of outcomes) {
      await this.deps.inbox
        .reportDeliverable({ jobId: job.jobId, repository: o.repository, deliverable: o.deliverable, branch: o.branch, commits: o.pushed ? o.commits : 0, mergeRequestUrl: o.mergeRequestUrl, error: o.error })
        .catch((e: Error) => this.log(`job ${job.jobId}: reportDeliverable: ${e.message}`))
    }
    await this.report(job, job.closure?.note ? `closed with verdict ${verdict}: ${job.closure.note.slice(0, 500)}` : `closed with verdict ${verdict}`)
    await this.deps.table.drop(job.jobId)
    await this.deps.workspace.evict(this.deps.table.connectorRefsInUse())
  }
}
