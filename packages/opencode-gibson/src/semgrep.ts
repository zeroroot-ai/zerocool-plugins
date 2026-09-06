// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

/**
 * semgrep — the candidate producer for the source-analysis task
 * (zerocool-plugins#87).
 *
 * semgrep runs the vendored ruleset (`semgrep/rules.yaml`, pinned with the
 * package, never fetched) over a checkout and prints one JSON document. The
 * parser below is pure and is tested against bytes recorded from semgrep
 * 1.175.0 over the fixture repository, so a change in semgrep's output fails a
 * unit test rather than a Scan mission.
 *
 * A match is a CANDIDATE, not a Finding. The model triages each one in
 * `source-analysis.ts`; nothing here decides.
 */

/** One semgrep match, reduced to what triage and a Finding need. */
export interface SemgrepCandidate {
  /** The rule id, e.g. `rules.js-eval-of-request-input`. */
  checkId: string
  /** Repository-relative path, as semgrep printed it. */
  path: string
  line: number
  endLine: number
  message: string
  /** semgrep's own level: ERROR, WARNING or INFO. */
  severity: string
  /** CWE strings from the rule's metadata, verbatim (`CWE-79: ...`). */
  cwe: string[]
  /** The rule's `metadata.category`, when it set one. */
  category?: string
  /** The matched source lines. */
  snippet: string
}

interface SemgrepResult {
  check_id?: string
  path?: string
  start?: { line?: number }
  end?: { line?: number }
  extra?: {
    message?: string
    severity?: string
    lines?: string
    metadata?: { cwe?: string | string[]; category?: string }
  }
}

interface SemgrepDocument {
  results?: SemgrepResult[]
  errors?: { message?: string; level?: string }[]
}

/**
 * Parse the JSON `semgrep scan --json` writes. Throws when the document is not
 * JSON or carries an error semgrep itself marked as an error, because a partial
 * candidate list would look like a clean checkout.
 */
export function parseSemgrepOutput(stdout: string): SemgrepCandidate[] {
  let doc: SemgrepDocument
  try {
    doc = JSON.parse(stdout) as SemgrepDocument
  } catch (e) {
    throw new Error(`semgrep output is not JSON: ${(e as Error).message}`)
  }
  const fatal = (doc.errors ?? []).filter((err) => (err.level ?? "error") === "error")
  if (fatal.length > 0) {
    throw new Error(`semgrep reported ${fatal.length} error(s): ${fatal.map((err) => err.message ?? "?").join("; ")}`)
  }
  return (doc.results ?? []).map((r) => {
    const cweRaw = r.extra?.metadata?.cwe
    const cwe = Array.isArray(cweRaw) ? cweRaw : cweRaw ? [cweRaw] : []
    return {
      checkId: bareRuleId(r.check_id ?? ""),
      path: r.path ?? "",
      line: r.start?.line ?? 0,
      endLine: r.end?.line ?? r.start?.line ?? 0,
      message: (r.extra?.message ?? "").trim(),
      severity: r.extra?.severity ?? "",
      cwe,
      ...(r.extra?.metadata?.category ? { category: r.extra.metadata.category } : {}),
      snippet: r.extra?.lines ?? "",
    }
  })
}

/**
 * semgrep prefixes a local rule's id with the config file's path, dot-joined
 * (`app.semgrep.js-eval-any` in the image, `rules.js-eval-any` from a relative
 * config). The rule is the last segment; the prefix is where the file sat. A
 * Finding must name the rule, not the install path, so the prefix is dropped.
 */
export function bareRuleId(checkId: string): string {
  const i = checkId.lastIndexOf(".")
  return i >= 0 ? checkId.slice(i + 1) : checkId
}

/** The vendored ruleset, resolved from the package it ships with. */
export function defaultRulesPath(): string {
  return fileURLToPath(new URL("../semgrep/rules.yaml", import.meta.url))
}

export interface SemgrepRunOptions {
  /** The checkout to scan. semgrep runs with this as its cwd and `.` as the target. */
  dir: string
  /** Ruleset path. Defaults to the vendored one. */
  rules?: string
  /** Binary to run. Overridable for a pinned install and for tests. */
  bin?: string
  /** Hard deadline. The child is killed when it elapses. */
  timeoutMs?: number
}

/**
 * Build the argv. Exported so a test can assert it.
 *
 * The target is `.` and the cwd is the checkout, on purpose: semgrep reports
 * paths relative to the target, so a Finding's `file` is repository-relative
 * rather than a sandbox path, and semgrep's default ignore list (which skips
 * `test/` directories anywhere in the path) is judged against the checkout,
 * not against wherever the sandbox mounted it.
 */
export function semgrepArgs(opts: SemgrepRunOptions): string[] {
  return [
    "scan",
    "--json",
    "--quiet",
    "--metrics=off",
    "--disable-version-check",
    "--config",
    opts.rules ?? defaultRulesPath(),
    ".",
  ]
}

/** A function that yields candidates for a checkout. The seam tests stub. */
export type SemgrepRunner = (opts: SemgrepRunOptions) => Promise<SemgrepCandidate[]>

/**
 * Run semgrep once over a checkout and return the candidates.
 *
 * semgrep exits 0 when the scan ran, with or without matches; anything else is
 * a failed scan and throws with semgrep's stderr tail, so a task never reports
 * "no findings" for a scan that did not happen.
 */
export const runSemgrep: SemgrepRunner = async (opts) => {
  const bin = opts.bin ?? process.env.ZEROCOOL_SEMGREP_BIN ?? "semgrep"
  const args = semgrepArgs(opts)

  return await new Promise<SemgrepCandidate[]>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.dir,
      env: { ...process.env, SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.timeoutMs && opts.timeoutMs > 0 ? { timeout: opts.timeoutMs, killSignal: "SIGTERM" as const } : {}),
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
    child.on("error", (e) => reject(new Error(`could not run ${bin}: ${e.message}`)))
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`semgrep timed out after ${opts.timeoutMs}ms (killed with ${signal})`))
        return
      }
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("; ")
        reject(new Error(`semgrep exited ${code}${tail ? `: ${tail}` : ""}`))
        return
      }
      try {
        resolve(parseSemgrepOutput(stdout))
      } catch (e) {
        reject(e as Error)
      }
    })
  })
}
