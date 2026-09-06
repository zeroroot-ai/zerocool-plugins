// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { FileChange, GitLabWriter, MergeRequest } from "./gitlab.js"

/**
 * The Fix — what the always-on agent does with a Finding (zerocool-plugins#89).
 *
 * After a Scan mission lands, the agent works the Application's open Findings
 * in priority order. For each one it can act on it rewrites the repository,
 * runs the repository's own tests, and only then opens a merge request set to
 * merge itself when the pipeline succeeds. It records the scan verdict on the
 * commit as `gibson/scan` and posts one note saying what it fixed, what it did
 * not, and why.
 *
 * THE ORDER IS TESTS, THEN PUSH. A fix that breaks the build is worse than the
 * Finding: it stops every other fix behind it. So the change is applied to a
 * workspace, the tests run there, and a failure resets the workspace and leaves
 * the Finding `open` with its reason recorded. Nothing unproven reaches GitLab.
 *
 * THE FIX NEVER MARKS A FINDING `verified`. A merge is not evidence that a
 * rescan did not see the weakness again — only the rescan is, and absence is
 * not an observation, so it is reconciled once at a scan's completion
 * (gibson#1686). The Fix moves a Finding `open` → `fixing` when its merge
 * request opens and `fixing` → `fixed` when GitLab reports that request merged.
 *
 * THE TOKEN NEVER APPEARS IN ANYTHING THIS WRITES. It reaches GitLab only as a
 * `PRIVATE-TOKEN` header inside {@link gitlabRestWriter}. No branch name, merge
 * request title, description, note or status description is built from it, and
 * `fix.test.ts` proves that with a sentinel that would show up in every
 * recorded output if it ever did.
 *
 * THE TWO PLATFORM SEAMS ARE LIVE. Reading an Application's Findings and
 * writing a Finding's status arrived on the TypeScript wire in
 * `@zeroroot-ai/sdk@0.10.0` (sdk-ts#51), so {@link harnessFindingSource} and
 * {@link harnessFindingStatus} below back {@link FindingSource} and
 * {@link FindingStatusWriter} on the per-dispatch task grant. They stayed
 * seams rather than becoming direct calls, which is what let this file be
 * driven by stubs before the wire existed and still be driven by them in
 * tests now that it does.
 */

/** Severities, worst first. Used for the note's counts and for a stable order. */
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const

/** A Finding as the Fix needs it — the read half of sdk-ts#51. */
export interface FixableFinding {
  /** The graph's `brain_id`, so a write lands on the node that was read. */
  id: string
  /** `open`, `fixing`, `fixed` or `verified`. */
  status: string
  severity: string
  /** The CVE, GHSA or platform id this Finding is an instance of. */
  vulnerabilityId: string
  /** Where it is: a `Package`, a `Repository` file, or a `Service`. */
  placeLabel: string
  placeKey: string
  /**
   * `P1`..`P4`, what a triage pass decided (gibson#1684). **Absent means no
   * pass has decided yet, never "unimportant"** — see {@link byWorkOrder}.
   */
  priority?: string
  /** The merge request already opened for this Finding, when it is `fixing`. */
  mergeRequestIid?: number
}

/** Reads an Application's Findings. Backed by {@link harnessFindingSource}. */
export interface FindingSource {
  /**
   * The Application's Findings in the given statuses, **in the order they
   * should be worked**. Rejects when the graph is unreachable; it must never
   * resolve empty to signal failure, because an empty list reads as a healthy
   * Application and the Fix would report success over a live backlog.
   */
  findings(application: string, statuses: string[]): Promise<FixableFinding[]>
}

/** Moves a Finding through its statuses. Backed by {@link harnessFindingStatus}. */
export interface FindingStatusWriter {
  /** Record that a merge request now proposes this Finding's fix. */
  markFixing(findingId: string, mr: MergeRequest): Promise<void>
  /** Record that the merge request merged. Never `verified` — the rescan does that. */
  markFixed(findingId: string): Promise<void>
}

/** A checkout the Fix can change and test before anything is pushed. */
export interface Workspace {
  /** File contents, or `undefined` when the path does not exist. */
  read(path: string): Promise<string | undefined>
  /** Stage a rewrite in the workspace. Not a push. */
  write(path: string, content: string): Promise<void>
  /** Run the repository's own tests. `output` is quoted in the note on failure. */
  test(): Promise<{ ok: boolean; output: string }>
  /** Discard staged rewrites, so a failed fix does not leak into the next one. */
  reset(): Promise<void>
  /** What was staged, in commit order. */
  staged(): FileChange[]
}

/** What the agent proposes to do about one Finding. */
export interface FixPlan {
  /** Which of the three the owner's scope named. Reported in the note. */
  kind: "dependency" | "source" | "config"
  /** One line, for the merge request title. */
  summary: string
  /** The commit message body. */
  detail: string
}

/**
 * Decides what to change for a Finding, and stages it in the workspace.
 *
 * Returning `undefined` means "no strategy for this Finding" — reported in the
 * note as unfixed with that reason, never silently skipped. A planner that
 * throws is treated the same way, with its message as the reason: one Finding
 * with no strategy must not stop the ones behind it.
 */
export interface FixPlanner {
  plan(finding: FixableFinding, ws: Workspace): Promise<FixPlan | undefined>
}

/** What happened to one Finding in a Fix pass. */
export interface FixOutcome {
  finding: FixableFinding
  /** `fixing` when a merge request opened, `merged` when one already had, else `unfixed`. */
  result: "fixing" | "merged" | "unfixed"
  /** Why it is unfixed. Empty otherwise. Quoted verbatim in the note. */
  reason: string
  mergeRequest?: MergeRequest
  plan?: FixPlan
}

/** One line of the console stream, so the ops wall shows the Fix working. */
export type FixEvent =
  | { type: "fix.start"; application: string; commit: string; open: number; fixing: number }
  | { type: "fix.plan"; findingId: string; kind: FixPlan["kind"]; summary: string }
  | { type: "fix.tests"; findingId: string; ok: boolean }
  | { type: "fix.mr"; findingId: string; iid: number; webUrl: string }
  | { type: "fix.merged"; findingId: string; iid: number }
  | { type: "fix.skip"; findingId: string; reason: string }
  | { type: "fix.error"; stage: "read" | "status" | "note" | "plan"; message: string }

export interface FixSummary {
  application: string
  commit: string
  outcomes: FixOutcome[]
  /** True when every Finding that had a strategy ended `fixing` or `merged`. */
  clean: boolean
}

export interface RunFixOptions {
  application: string
  /** The commit the Scan mission ran against — what the status is set on. */
  commit: string
  /** The branch merge requests target. */
  targetRef: string
  findings: FindingSource
  status: FindingStatusWriter
  planner: FixPlanner
  workspace: Workspace
  gitlab: GitLabWriter
  /** The pipeline page, linked from the commit status. */
  pipelineUrl?: string
  /** Cap on merge requests opened in one pass, so a backlog cannot flood review. */
  maxMergeRequests?: number
  onEvent?: (e: FixEvent) => void
}

/** Default ceiling on merge requests opened by one pass. */
export const DEFAULT_MAX_MERGE_REQUESTS = 10

/**
 * Run one Fix pass over an Application.
 *
 * Reconcile first, then fix. A Finding already `fixing` whose merge request has
 * merged becomes `fixed` before anything new is opened, so a pass never opens a
 * second merge request for a Finding the previous pass already resolved.
 */
export async function runFix(opts: RunFixOptions): Promise<FixSummary> {
  const emit = (e: FixEvent): void => opts.onEvent?.(e)
  const cap = opts.maxMergeRequests ?? DEFAULT_MAX_MERGE_REQUESTS
  const outcomes: FixOutcome[] = []

  const all = await opts.findings.findings(opts.application, ["open", "fixing"])
  const fixing = all.filter((f) => f.status === "fixing")
  const open = all.filter((f) => f.status === "open")
  emit({ type: "fix.start", application: opts.application, commit: opts.commit, open: open.length, fixing: fixing.length })

  // Reconcile: a merge request that merged moves its Finding to `fixed`.
  for (const finding of fixing) {
    if (finding.mergeRequestIid === undefined) continue
    try {
      const mr = await opts.gitlab.mergeRequestState(finding.mergeRequestIid)
      if (mr.state !== "merged") continue
      await opts.status.markFixed(finding.id)
      emit({ type: "fix.merged", findingId: finding.id, iid: mr.iid })
      outcomes.push({ finding, result: "merged", reason: "", mergeRequest: mr })
    } catch (e) {
      emit({ type: "fix.error", stage: "status", message: message(e) })
    }
  }

  let opened = 0
  for (const finding of open) {
    if (opened >= cap) {
      outcomes.push({ finding, result: "unfixed", reason: `merge request cap of ${cap} reached in this pass` })
      emit({ type: "fix.skip", findingId: finding.id, reason: "cap reached" })
      continue
    }

    let plan: FixPlan | undefined
    try {
      plan = await opts.planner.plan(finding, opts.workspace)
    } catch (e) {
      await safeReset(opts.workspace)
      outcomes.push({ finding, result: "unfixed", reason: `planning failed: ${message(e)}` })
      emit({ type: "fix.error", stage: "plan", message: message(e) })
      continue
    }

    if (!plan) {
      await safeReset(opts.workspace)
      outcomes.push({ finding, result: "unfixed", reason: "no fix strategy for this finding" })
      emit({ type: "fix.skip", findingId: finding.id, reason: "no fix strategy" })
      continue
    }

    const changes = opts.workspace.staged()
    if (changes.length === 0) {
      await safeReset(opts.workspace)
      outcomes.push({ finding, result: "unfixed", reason: "the planner changed nothing" })
      emit({ type: "fix.skip", findingId: finding.id, reason: "no change staged" })
      continue
    }
    emit({ type: "fix.plan", findingId: finding.id, kind: plan.kind, summary: plan.summary })

    const tests = await opts.workspace.test()
    emit({ type: "fix.tests", findingId: finding.id, ok: tests.ok })
    if (!tests.ok) {
      await safeReset(opts.workspace)
      outcomes.push({ finding, result: "unfixed", plan, reason: `the repository's tests failed: ${firstLines(tests.output)}` })
      continue
    }

    try {
      const branch = fixBranch(finding)
      await opts.gitlab.commitToBranch(branch, opts.targetRef, `${plan.summary}\n\n${plan.detail}`, changes)
      const mr = await opts.gitlab.openMergeRequest(branch, opts.targetRef, plan.summary, mergeRequestBody(finding, plan))
      emit({ type: "fix.mr", findingId: finding.id, iid: mr.iid, webUrl: mr.webUrl })
      opened++
      await opts.status.markFixing(finding.id, mr)
      outcomes.push({ finding, result: "fixing", reason: "", mergeRequest: mr, plan })
    } catch (e) {
      outcomes.push({ finding, result: "unfixed", plan, reason: `GitLab refused the change: ${message(e)}` })
      emit({ type: "fix.error", stage: "status", message: message(e) })
    } finally {
      await safeReset(opts.workspace)
    }
  }

  const summary: FixSummary = {
    application: opts.application,
    commit: opts.commit,
    outcomes,
    clean: outcomes.every((o) => o.result !== "unfixed"),
  }

  // The verdict lands on the commit that was scanned, whatever happened above.
  // A pass that could not reach GitLab for the status still reports its work
  // through the return value, so the caller is never told the pass did nothing.
  try {
    await opts.gitlab.setCommitStatus(
      opts.commit,
      summary.clean ? "success" : "failed",
      statusDescription(summary),
      opts.pipelineUrl,
    )
  } catch (e) {
    emit({ type: "fix.error", stage: "note", message: message(e) })
  }

  for (const outcome of outcomes) {
    if (outcome.result !== "fixing" || !outcome.mergeRequest) continue
    try {
      await opts.gitlab.comment(outcome.mergeRequest.iid, noteBody(summary))
    } catch (e) {
      emit({ type: "fix.error", stage: "note", message: message(e) })
    }
  }

  return summary
}

/**
 * The branch one Finding's fix lands on. Stable, so a retry reuses it rather
 * than opening a second merge request for the same Finding.
 *
 * The slug keeps only `[a-z0-9-]`. Dots are dropped rather than preserved:
 * git refuses a ref containing `..`, and a vulnerability id is attacker-
 * adjacent text that ends up interpolated into a URL path, so a dot run is
 * exactly the shape not to carry through. The Finding id is appended so two
 * occurrences of one CVE get two branches.
 */
export function fixBranch(finding: FixableFinding): string {
  const slug = `${finding.vulnerabilityId || finding.id}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `gibson/fix-${slug || "unclassified"}-${finding.id.slice(0, 8)}`
}

/** Counts by severity, worst first, for the note and the status line. */
export function countsBySeverity(findings: FixableFinding[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of SEVERITIES) {
    const n = findings.filter((f) => f.severity.toLowerCase() === s).length
    if (n > 0) out[s] = n
  }
  const known = new Set<string>(SEVERITIES)
  const other = findings.filter((f) => !known.has(f.severity.toLowerCase())).length
  if (other > 0) out.other = other
  return out
}

/** The one-line verdict GitLab shows beside the commit. */
export function statusDescription(summary: FixSummary): string {
  const fixing = summary.outcomes.filter((o) => o.result === "fixing").length
  const merged = summary.outcomes.filter((o) => o.result === "merged").length
  const unfixed = summary.outcomes.filter((o) => o.result === "unfixed").length
  if (summary.outcomes.length === 0) return "no open findings"
  return `${fixing} merge request(s) opened, ${merged} merged, ${unfixed} left for a human`
}

/** The merge request description. Names the Finding it closes and how. */
export function mergeRequestBody(finding: FixableFinding, plan: FixPlan): string {
  return [
    plan.detail,
    "",
    `Finding: \`${finding.id}\``,
    `Vulnerability: \`${finding.vulnerabilityId || "unclassified"}\``,
    `Where: ${finding.placeLabel} \`${finding.placeKey}\``,
    `Severity: ${finding.severity}${finding.priority ? ` · priority ${finding.priority}` : ""}`,
    "",
    "Opened by the Gibson always-on agent. It merges itself when the pipeline",
    "succeeds. The finding is marked fixed on merge and verified only by a",
    "later rescan.",
  ].join("\n")
}

/** The note posted on each merge request: what this pass did, in full. */
export function noteBody(summary: FixSummary): string {
  const lines: string[] = [
    `### Gibson scan of \`${summary.commit.slice(0, 12)}\` on ${summary.application}`,
    "",
  ]
  const counts = countsBySeverity(summary.outcomes.map((o) => o.finding))
  const rendered = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")
  lines.push(rendered ? `Findings this pass: ${rendered}.` : "No open findings this pass.")
  lines.push("")

  const fixed = summary.outcomes.filter((o) => o.result === "fixing" || o.result === "merged")
  if (fixed.length > 0) {
    lines.push("**Fixed**")
    for (const o of fixed) {
      const where = `${o.finding.placeLabel} \`${o.finding.placeKey}\``
      const link = o.mergeRequest?.webUrl ? ` — ${o.mergeRequest.webUrl}` : ""
      lines.push(`- ${o.finding.vulnerabilityId || o.finding.id} in ${where}${link}`)
    }
    lines.push("")
  }

  const unfixed = summary.outcomes.filter((o) => o.result === "unfixed")
  if (unfixed.length > 0) {
    lines.push("**Left for a human**")
    for (const o of unfixed) {
      const where = `${o.finding.placeLabel} \`${o.finding.placeKey}\``
      lines.push(`- ${o.finding.vulnerabilityId || o.finding.id} in ${where} — ${o.reason}`)
    }
  }
  return lines.join("\n")
}

async function safeReset(ws: Workspace): Promise<void> {
  try {
    await ws.reset()
  } catch {
    // A reset that fails is reported by the next planner call changing nothing.
  }
}

function firstLines(output: string, n = 3): string {
  return output.split("\n").slice(0, n).join(" ").trim()
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// --------------------------------------------------------------------------
// the platform seams, backed by the task grant (zerocool-plugins#96)
// --------------------------------------------------------------------------

/**
 * Priority order, worst first. `P1` is the most urgent thing a triage pass
 * found; anything it has not ranked sorts AFTER everything it has.
 *
 * An unranked Finding is not a low-priority one — it is one no pass has
 * decided about yet (gibson#1684). Ranking it as `P4` would be inventing a
 * decision nobody took, and the triage agent's keep-previous rule would then
 * preserve that invention on the next pass. So unranked sorts last among
 * peers rather than being scored, and severity breaks the tie beneath it, so
 * a critical unranked Finding still outranks a low unranked one.
 */
const PRIORITY_ORDER = ["p1", "p2", "p3", "p4"] as const

function priorityRank(priority: string | undefined): number {
  const i = PRIORITY_ORDER.indexOf((priority ?? "").toLowerCase() as (typeof PRIORITY_ORDER)[number])
  return i === -1 ? PRIORITY_ORDER.length : i
}

function severityRank(severity: string): number {
  const i = SEVERITIES.indexOf(severity.toLowerCase() as (typeof SEVERITIES)[number])
  return i === -1 ? SEVERITIES.length : i
}

/**
 * The order the Fix works Findings in: priority first, severity beneath it,
 * then the Finding id so a pass over unchanged input is deterministic.
 *
 * Deterministic order matters beyond tidiness: the merge-request cap means the
 * tail of this list is what gets deferred to the next pass, so an unstable
 * sort would defer a different Finding each run and none would ever be worked.
 */
export function byWorkOrder(a: FixableFinding, b: FixableFinding): number {
  const p = priorityRank(a.priority) - priorityRank(b.priority)
  if (p !== 0) return p
  const s = severityRank(a.severity) - severityRank(b.severity)
  if (s !== 0) return s
  return a.id.localeCompare(b.id)
}

/**
 * Read an Application's Findings over the task grant (sdk-ts#51).
 *
 * The rejection is deliberately NOT caught. `applicationFindings` throws when
 * the graph is unreachable, and swallowing that into an empty list is the one
 * failure this whole seam exists to prevent: the Fix would report a clean
 * Application over a live backlog, and it would look exactly like health.
 */
export function harnessFindingSource(knowledge: KnowledgeReadsFindings): FindingSource {
  return {
    async findings(application: string, statuses: string[]): Promise<FixableFinding[]> {
      const found = await knowledge.applicationFindings({ application, statuses })
      return found
        .map((f) => ({
          id: f.findingId,
          status: f.status,
          severity: f.severity,
          vulnerabilityId: f.vulnerabilityId,
          placeLabel: f.placeLabel,
          placeKey: f.placeKey,
          // Omitted rather than defaulted: empty means no pass has decided.
          ...(f.priority ? { priority: f.priority } : {}),
        }))
        .sort(byWorkOrder)
    },
  }
}

/** The single read the Fix needs from a knowledge source. */
export interface KnowledgeReadsFindings {
  applicationFindings(opts: {
    application: string
    statuses?: string[]
    limit?: number
  }): Promise<ReadFinding[]>
}

/** The fields of an `ApplicationFinding` the Fix reads. */
export interface ReadFinding {
  findingId: string
  status: string
  severity: string
  vulnerabilityId: string
  placeLabel: string
  placeKey: string
  priority: string
}

/** Writes one lifecycle sighting. Satisfied by the SDK's `observe`. */
export type ObserveLifecycle = (entity: {
  label: string
  idProperties: Record<string, string>
  properties?: Record<string, string>
}) => Promise<void>

/**
 * Move a Finding through its statuses over the task grant (sdk-ts#51).
 *
 * The Finding is named by its `brain_id` in `idProperties`, so the write lands
 * on the node the scan raised rather than creating a second one beside it.
 *
 * Only the properties this transition decides are sent. A sighting that omits
 * a property leaves whatever an earlier one established; one that sets it to
 * `""` erases it. The Fix decides a status and, when it has one, the merge
 * request — it decides nothing about severity, priority or reason, so it sends
 * none of them and cannot blank what the scan or a triage pass recorded.
 *
 * There is no `markVerified`, and there is no branch here that could reach it.
 * `verified` follows a rescan not seeing the weakness again, and absence is not
 * an observation this process can make (gibson#1686).
 */
export function harnessFindingStatus(observe: ObserveLifecycle): FindingStatusWriter {
  const write = (findingId: string, properties: Record<string, string>): Promise<void> =>
    observe({ label: "Finding", idProperties: { brain_id: findingId }, properties })

  return {
    async markFixing(findingId: string, mr: MergeRequest): Promise<void> {
      await write(findingId, {
        status: "fixing",
        merge_request_iid: String(mr.iid),
        merge_request_url: mr.webUrl,
      })
    },
    async markFixed(findingId: string): Promise<void> {
      await write(findingId, { status: "fixed" })
    },
  }
}
