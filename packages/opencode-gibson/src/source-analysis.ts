// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { newFinding, type Finding, type Severity, type TaskHarness } from "@zeroroot-ai/sdk"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { FindingsBackend } from "./findings.js"
import { runSemgrep, type SemgrepCandidate, type SemgrepRunner } from "./semgrep.js"

/**
 * The source-analysis task (zerocool-plugins#87).
 *
 * semgrep produces candidates from a checkout; the model triages each one as
 * real or noise; every real one is submitted as a Finding that names its
 * Vulnerability (a CWE, or a platform id when the rule carries none), the file
 * and line, and the model's reason. The task reads the checkout and writes
 * Findings. It changes no file and pushes nothing — that is the Fix's job
 * (zerocool-plugins#89), a different task with a different grant posture.
 *
 * Deterministic first, model second. semgrep decides what is a candidate; the
 * model only decides whether a candidate is real, given the rule's message and
 * the code around the match. A rule that never yields a real finding is
 * removed from the ruleset rather than argued with in a prompt.
 *
 * Every seam is injectable — the semgrep runner, the model, the findings
 * backend, the file reader — so the test in `source-analysis.test.ts` drives a
 * whole pass over the fixture repository with no semgrep binary, no network,
 * and no daemon.
 */

/** What the model said about one candidate. */
export interface Triage {
  verdict: "real" | "noise"
  reason: string
}

/** The model seam: one candidate in, one verdict out. */
export type TriageModel = (c: AnalysisCandidate, snippet: string) => Promise<Triage>

/** A deduplicated candidate: one place, one Vulnerability, the rules that hit it. */
export interface AnalysisCandidate extends SemgrepCandidate {
  /** `CWE-95`, or `zerocool:semgrep:<rule>` when the rule names no CWE. */
  vulnerabilityId: string
  /** Every rule that matched this place for this Vulnerability. */
  ruleIds: string[]
}

/** semgrep's level, ranked so the strongest rule wins a deduplicated place. */
const LEVEL_RANK: Record<string, number> = { ERROR: 3, WARNING: 2, INFO: 1 }

/**
 * The Vulnerability id for a candidate. A CWE from the rule's metadata wins,
 * normalized to `CWE-<n>` so the same weakness from two rules is one node in
 * the graph. A rule with no CWE gets a platform id keyed by the rule, which is
 * still stable across runs and repositories.
 */
export function vulnerabilityId(c: SemgrepCandidate): string {
  for (const raw of c.cwe) {
    const m = /CWE-(\d+)/i.exec(raw)
    if (m) return `CWE-${m[1]}`
  }
  return `zerocool:semgrep:${c.checkId}`
}

/**
 * Collapse matches to one candidate per (path, line, Vulnerability). Two rules
 * that flag the same eval on the same line are one weakness, and two Findings
 * for it would be one duplicate for a person to close. The strongest rule's
 * level and message are kept; every rule id is recorded.
 */
export function dedupeCandidates(matches: SemgrepCandidate[]): AnalysisCandidate[] {
  const byKey = new Map<string, AnalysisCandidate>()
  for (const m of matches) {
    const id = vulnerabilityId(m)
    const key = `${m.path}:${m.line}:${id}`
    const seen = byKey.get(key)
    if (!seen) {
      byKey.set(key, { ...m, vulnerabilityId: id, ruleIds: [m.checkId] })
      continue
    }
    if (!seen.ruleIds.includes(m.checkId)) seen.ruleIds.push(m.checkId)
    if ((LEVEL_RANK[m.severity] ?? 0) > (LEVEL_RANK[seen.severity] ?? 0)) {
      seen.severity = m.severity
      seen.message = m.message
      seen.checkId = m.checkId
      seen.endLine = Math.max(seen.endLine, m.endLine)
    }
  }
  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
}

/** Lines around a match, numbered, for the model and for the Finding's evidence. */
export async function readSnippet(
  dir: string,
  c: SemgrepCandidate,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
  context = 4,
): Promise<string> {
  let text: string
  try {
    text = await read(join(dir, c.path))
  } catch {
    return ""
  }
  const lines = text.split("\n")
  const from = Math.max(1, c.line - context)
  const to = Math.min(lines.length, c.endLine + context)
  const out: string[] = []
  for (let n = from; n <= to; n++) {
    const mark = n >= c.line && n <= c.endLine ? ">" : " "
    out.push(`${mark} ${String(n).padStart(4)} | ${lines[n - 1] ?? ""}`)
  }
  return out.join("\n")
}

/**
 * The triage prompt. The model gets the rule's message, the weakness, and the
 * code; it answers with one JSON object. Exported so the wording is testable
 * and so a reader can see exactly what the model is asked.
 */
export function triageMessages(c: AnalysisCandidate, snippet: string): { role: string; content: string }[] {
  return [
    {
      role: "system",
      content:
        "You triage static-analysis matches in application source code. For the match below, " +
        "decide whether it is a real weakness an attacker or a caller could exploit, or noise " +
        "(a constant, dead code, a test, a value no caller can influence). Answer with exactly " +
        'one JSON object and nothing else: {"verdict":"real"|"noise","reason":"<one sentence>"}.',
    },
    {
      role: "user",
      content:
        `Rule: ${c.ruleIds.join(", ")}\n` +
        `Weakness: ${c.vulnerabilityId}\n` +
        `Rule message: ${c.message}\n` +
        `File: ${c.path} lines ${c.line}-${c.endLine}\n\n` +
        `${snippet || "(source not available)"}`,
    },
  ]
}

/**
 * Parse the model's answer. Tolerant of prose around the object, strict about
 * the verdict: anything but a clear "real" is noise, because a Finding the
 * model did not clearly confirm is exactly the noise this task exists to drop.
 */
export function parseTriage(text: string): Triage {
  const m = /\{[\s\S]*\}/.exec(text)
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { verdict?: unknown; reason?: unknown }
      const verdict = String(obj.verdict ?? "").toLowerCase() === "real" ? "real" : "noise"
      const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "no reason given"
      return { verdict, reason }
    } catch {
      // fall through
    }
  }
  return { verdict: "noise", reason: `model answer was not the expected JSON: ${text.slice(0, 120)}` }
}

/**
 * The model behind the task grant: one `LLMComplete` on the harness per
 * candidate, on the tenant's own provider, through the harness so the call is
 * traced and budgeted like every other model call the run makes.
 */
export function harnessTriageModel(harness: TaskHarness, slot = "primary"): TriageModel {
  return async (c, snippet) => {
    const res = await harness.client.lLMComplete({
      context: harness.context,
      slot,
      messages: triageMessages(c, snippet).map((m) => ({ role: m.role, content: m.content })) as never,
      temperature: 0,
      stop: [],
    })
    if (res.error) throw new Error(`LLMComplete refused: ${res.error.message}`)
    return parseTriage(res.content)
  }
}

/** semgrep's level mapped onto the Finding severity scale. */
export function findingSeverity(level: string): Severity {
  if (level === "ERROR") return "high"
  if (level === "WARNING") return "medium"
  return "low"
}

/** What the Finding needs to say where it came from. */
export interface AnalysisProvenance {
  missionId?: string
  /** `https://gitlab.com/examplebank/customer-portal`, when the task knows it. */
  repository?: string
  commit?: string
  targetId?: string
}

/**
 * Build the Finding for a real candidate. The Vulnerability id, the file and
 * the line travel in the title, the tags and the evidence, so they survive the
 * typed `SubmitFinding` mapping, which carries no free-form metadata.
 */
export function candidateFinding(
  c: AnalysisCandidate,
  triage: Triage,
  snippet: string,
  prov: AnalysisProvenance,
): Finding {
  const where = `${c.path}:${c.line}`
  return newFinding({
    title: `${c.vulnerabilityId} at ${where}: ${c.message.split(".")[0] ?? c.message}`.slice(0, 200),
    description:
      `${c.message}\n\n` +
      `Vulnerability: ${c.vulnerabilityId}\n` +
      `File: ${c.path}\nLines: ${c.line}-${c.endLine}\n` +
      `Rules: ${c.ruleIds.join(", ")}\n` +
      (prov.repository ? `Repository: ${prov.repository}${prov.commit ? ` @ ${prov.commit}` : ""}\n` : "") +
      `\nTriage: ${triage.reason}`,
    category: c.category ?? "source",
    severity: findingSeverity(c.severity),
    confidence: 0.8,
    missionID: prov.missionId ?? "",
    agentName: "zerocool",
    ...(prov.targetId ? { targetID: prov.targetId } : {}),
    tags: [
      "source-analysis",
      `vulnerability:${c.vulnerabilityId}`,
      `file:${c.path}`,
      `line:${c.line}`,
      ...c.ruleIds.map((r) => `semgrep:${r}`),
      ...(prov.commit ? [`commit:${prov.commit}`] : []),
    ],
    evidence: [
      {
        type: "code",
        title: where,
        content: snippet || "(source not available)",
        timestamp: new Date().toISOString(),
        metadata: { path: c.path, line: c.line, end_line: c.endLine, rules: c.ruleIds },
      },
    ],
  })
}

export interface SourceAnalysisOptions {
  /** The checkout to analyze. */
  dir: string
  model: TriageModel
  findings: FindingsBackend
  provenance?: AnalysisProvenance
  /** Seams. */
  semgrep?: SemgrepRunner
  readFile?: (path: string) => Promise<string>
  rules?: string
  semgrepTimeoutMs?: number
  /** Progress events, one object per step, for the console stream. */
  onEvent?: (event: Record<string, unknown>) => void
}

/** What one pass produced. */
export interface SourceAnalysisSummary {
  matches: number
  candidates: number
  real: number
  noise: number
  /** Ids of the Findings submitted, in order. */
  findingIds: string[]
  /** Candidates the model or the backend failed on, with the error. Never silent. */
  failed: { candidate: string; error: string }[]
  /** Every verdict, for the terminal result and the MR note. */
  verdicts: { candidate: string; vulnerabilityId: string; verdict: Triage["verdict"]; reason: string }[]
}

/**
 * One pass: scan, dedupe, triage, submit. A candidate the model or the backend
 * fails on is recorded in `failed` and the pass continues, so one bad answer
 * costs one candidate rather than the whole scan. The pass never throws for a
 * clean checkout; it throws only when semgrep itself could not run.
 */
export async function runSourceAnalysis(opts: SourceAnalysisOptions): Promise<SourceAnalysisSummary> {
  const emit = opts.onEvent ?? (() => {})
  const semgrep = opts.semgrep ?? runSemgrep

  emit({ type: "source_analysis", phase: "semgrep", dir: opts.dir })
  const matches = await semgrep({
    dir: opts.dir,
    ...(opts.rules ? { rules: opts.rules } : {}),
    ...(opts.semgrepTimeoutMs ? { timeoutMs: opts.semgrepTimeoutMs } : {}),
  })
  const candidates = dedupeCandidates(matches)
  emit({ type: "source_analysis", phase: "candidates", matches: matches.length, candidates: candidates.length })

  const summary: SourceAnalysisSummary = {
    matches: matches.length,
    candidates: candidates.length,
    real: 0,
    noise: 0,
    findingIds: [],
    failed: [],
    verdicts: [],
  }

  for (const c of candidates) {
    const label = `${c.path}:${c.line} ${c.vulnerabilityId}`
    const snippet = await readSnippet(opts.dir, c, opts.readFile)
    let triage: Triage
    try {
      triage = await opts.model(c, snippet)
    } catch (e) {
      summary.failed.push({ candidate: label, error: `triage: ${(e as Error).message}` })
      emit({ type: "source_analysis", phase: "triage", candidate: label, error: (e as Error).message })
      continue
    }
    summary.verdicts.push({ candidate: label, vulnerabilityId: c.vulnerabilityId, verdict: triage.verdict, reason: triage.reason })
    emit({ type: "source_analysis", phase: "triage", candidate: label, verdict: triage.verdict, reason: triage.reason })
    if (triage.verdict !== "real") {
      summary.noise += 1
      continue
    }
    summary.real += 1
    const finding = candidateFinding(c, triage, snippet, opts.provenance ?? {})
    try {
      const id = await opts.findings.submit(finding)
      summary.findingIds.push(id)
      emit({ type: "source_analysis", phase: "submit", candidate: label, finding_id: id })
    } catch (e) {
      summary.failed.push({ candidate: label, error: `submit: ${(e as Error).message}` })
      emit({ type: "source_analysis", phase: "submit", candidate: label, error: (e as Error).message })
    }
  }

  emit({ type: "source_analysis", phase: "done", ...summaryCounts(summary) })
  return summary
}

function summaryCounts(s: SourceAnalysisSummary): Record<string, number> {
  return { matches: s.matches, candidates: s.candidates, real: s.real, noise: s.noise, submitted: s.findingIds.length, failed: s.failed.length }
}

/** The human-readable result the mission node records. */
export function formatSourceAnalysis(s: SourceAnalysisSummary): string {
  const lines = [
    `source analysis: ${s.matches} semgrep matches, ${s.candidates} candidates, ` +
      `${s.real} real, ${s.noise} noise, ${s.findingIds.length} findings submitted, ${s.failed.length} failed`,
  ]
  for (const v of s.verdicts) lines.push(`- ${v.verdict.padEnd(5)} ${v.candidate}: ${v.reason}`)
  for (const f of s.failed) lines.push(`- FAILED ${f.candidate}: ${f.error}`)
  return lines.join("\n")
}
