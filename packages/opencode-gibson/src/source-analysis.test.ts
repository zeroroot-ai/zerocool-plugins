// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { readDispatchContext, runDispatch, type DispatchContext } from "./dispatch.js"
import type { FindingsBackend } from "./findings.js"
import { bareRuleId, parseSemgrepOutput, semgrepArgs, type SemgrepCandidate } from "./semgrep.js"
import {
  candidateFinding,
  dedupeCandidates,
  findingSeverity,
  formatSourceAnalysis,
  parseTriage,
  readSnippet,
  runSourceAnalysis,
  triageMessages,
  vulnerabilityId,
  type AnalysisCandidate,
  type Triage,
  type TriageModel,
} from "./source-analysis.js"

/**
 * The source-analysis task (zerocool-plugins#87).
 *
 * The property under test throughout: **semgrep decides what is a candidate,
 * the model decides only whether a candidate is real, and the task writes
 * nothing but Findings.** A pass over the fixture repository must submit one
 * Finding per real weakness, drop the false positive with the model's reason
 * recorded, and leave every file on disk byte-identical.
 *
 * No test here runs semgrep, reaches a model, or dials a daemon. The semgrep
 * bytes are RECORDED from a real `semgrep scan --json` (1.175.0) over
 * `test/fixtures/source-analysis/repo` and replayed through the real parser, so
 * a change in semgrep's output shape fails a unit test rather than a Scan
 * mission. The model and the findings backend are stubs.
 *
 * RE-RECORDING THE FIXTURE — the trap that cost an afternoon: **semgrep scans
 * only the files `git ls-files` reports.** `test/fixtures/source-analysis/repo`
 * is not its own repository; it is tracked inside zerocool-plugins, and that is
 * what makes it visible. An untracked copy of the same tree scans to zero
 * results and looks exactly like a clean checkout. To re-record:
 *
 *     git add packages/opencode-gibson/test/fixtures/source-analysis/repo
 *     cd packages/opencode-gibson/test/fixtures/source-analysis/repo
 *     semgrep scan --json --quiet --metrics=off --disable-version-check \
 *       --config ../../../../semgrep/rules.yaml . > ../semgrep.json
 *
 * The cwd is the checkout and the target is `.` on purpose: semgrep reports
 * paths relative to the target (so a Finding's file is repository-relative),
 * and its default ignore list — which skips any path containing `test/` — is
 * judged against the checkout rather than against where the tree happens to sit.
 */

// --------------------------------------------------------------------------
// fixture
// --------------------------------------------------------------------------

const fixtureDir = fileURLToPath(new URL("../test/fixtures/source-analysis/", import.meta.url))
const repoDir = join(fixtureDir, "repo")

const recordedSemgrep = async (): Promise<string> => await readFile(join(fixtureDir, "semgrep.json"), "utf8")

/** The recorded run, through the real parser. */
const recordedCandidates = async (): Promise<SemgrepCandidate[]> => parseSemgrepOutput(await recordedSemgrep())

/**
 * The fixture's three weaknesses, by line:
 *   13 — eval(req.body.expression)      REAL, CWE-95 (two rules match it)
 *   19 — exec("ping -c 1 " + req.query) REAL, CWE-78
 *   26 — eval("({ newCheckout: true })") NOISE, CWE-95 on a constant
 */
const REAL_LINES = [13, 19]
const NOISE_LINE = 26

/**
 * A stub model standing in for the triage call. It judges the way the real one
 * is asked to: a match whose snippet shows request input is real, a match on a
 * string literal is noise. Deterministic, so the assertions below are exact.
 */
const stubModel: TriageModel = async (c, snippet) => {
  assert.ok(snippet.length > 0, `the model must be given the source around ${c.path}:${c.line}`)
  return c.line === NOISE_LINE
    ? { verdict: "noise", reason: "the argument is a string literal no caller can influence" }
    : { verdict: "real", reason: "the argument comes from request input" }
}

/** A findings backend that records what it was asked to submit. */
function recordingFindings(): FindingsBackend & { submitted: Parameters<FindingsBackend["submit"]>[0][] } {
  const submitted: Parameters<FindingsBackend["submit"]>[0][] = []
  return {
    submitted,
    submit: async (f) => {
      submitted.push(f)
      return f.id
    },
    describe: () => "test recorder",
  }
}

/** Content hash of every file in a tree, so a test can prove nothing changed. */
async function treeSnapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      const [text, st] = [await readFile(abs, "utf8"), await stat(abs)]
      out[rel] = `${st.size}:${text}`
    }
  }
  await walk(dir, "")
  return out
}

// --------------------------------------------------------------------------
// semgrep: the parser, against recorded bytes
// --------------------------------------------------------------------------

test("parseSemgrepOutput reads the recorded run: four matches with rule, place and CWE", async () => {
  const found = await recordedCandidates()
  assert.equal(found.length, 4)

  assert.deepEqual(
    found.map((c) => `${c.checkId}@${c.path}:${c.line}`),
    [
      "js-eval-any@src/server.js:13",
      "js-eval-of-request-input@src/server.js:13",
      "js-child-process-shell-concat@src/server.js:19",
      "js-eval-any@src/server.js:26",
    ],
  )
  // Every rule in the vendored set names its CWE; the task turns that into the
  // Vulnerability id, so a rule that stops carrying one is a real regression.
  for (const c of found) assert.ok(c.cwe.length > 0, `${c.checkId} carries no CWE`)
  assert.equal(found[1]?.severity, "ERROR")
  assert.equal(found[0]?.severity, "WARNING")
  assert.equal(found[0]?.category, "injection")
})

test("parseSemgrepOutput refuses output that is not JSON", () => {
  assert.throws(() => parseSemgrepOutput("semgrep: command not found"), /not JSON/)
})

test("parseSemgrepOutput refuses a run semgrep itself marked as failed", () => {
  // A partial candidate list is indistinguishable from a clean checkout, which
  // is the one wrong answer this task must never give.
  const doc = JSON.stringify({ results: [], errors: [{ level: "error", message: "rule parse error" }] })
  assert.throws(() => parseSemgrepOutput(doc), /rule parse error/)
})

test("parseSemgrepOutput keeps a warning-level error, which is not a failed scan", () => {
  const doc = JSON.stringify({ results: [], errors: [{ level: "warn", message: "a file was skipped" }] })
  assert.deepEqual(parseSemgrepOutput(doc), [])
})

test("bareRuleId drops the config path semgrep prefixes onto a local rule", () => {
  assert.equal(bareRuleId("app.semgrep.js-eval-any"), "js-eval-any")
  assert.equal(bareRuleId("rules.js-eval-any"), "js-eval-any")
  assert.equal(bareRuleId("js-eval-any"), "js-eval-any")
})

test("semgrepArgs scans the checkout with the vendored rules, no registry and no metrics", () => {
  const args = semgrepArgs({ dir: "/w", rules: "/r/rules.yaml" })
  assert.deepEqual(args, [
    "scan",
    "--json",
    "--quiet",
    "--metrics=off",
    "--disable-version-check",
    "--config",
    "/r/rules.yaml",
    ".",
  ])
})

// --------------------------------------------------------------------------
// candidates: Vulnerability identity and deduplication
// --------------------------------------------------------------------------

test("vulnerabilityId normalizes the rule's CWE so one weakness is one node", () => {
  const c = (cwe: string[]): SemgrepCandidate => ({
    checkId: "r",
    path: "a.js",
    line: 1,
    endLine: 1,
    message: "",
    severity: "ERROR",
    cwe,
    snippet: "",
  })
  assert.equal(vulnerabilityId(c(["CWE-95: Improper Neutralization of Directives"])), "CWE-95")
  assert.equal(vulnerabilityId(c(["cwe-79: XSS"])), "CWE-79")
})

test("vulnerabilityId falls back to a platform id when the rule names no CWE", () => {
  const c: SemgrepCandidate = {
    checkId: "custom-rule",
    path: "a.js",
    line: 1,
    endLine: 1,
    message: "",
    severity: "ERROR",
    cwe: [],
    snippet: "",
  }
  assert.equal(vulnerabilityId(c), "zerocool:semgrep:custom-rule")
})

test("dedupeCandidates collapses two rules on one place to one candidate", async () => {
  const candidates = dedupeCandidates(await recordedCandidates())

  // Four matches, three places: lines 13 and 26 are CWE-95, line 19 is CWE-78.
  assert.equal(candidates.length, 3)
  assert.deepEqual(
    candidates.map((c) => `${c.path}:${c.line} ${c.vulnerabilityId}`),
    ["src/server.js:13 CWE-95", "src/server.js:19 CWE-78", "src/server.js:26 CWE-95"],
  )

  const merged = candidates[0]
  assert.ok(merged)
  assert.deepEqual(merged.ruleIds.sort(), ["js-eval-any", "js-eval-of-request-input"])
  // The strongest rule wins the level and the message a person reads.
  assert.equal(merged.severity, "ERROR")
  assert.equal(merged.checkId, "js-eval-of-request-input")
  assert.match(merged.message, /request input/)
})

// --------------------------------------------------------------------------
// snippet
// --------------------------------------------------------------------------

test("readSnippet numbers the lines and marks the matched ones", async () => {
  const snippet = await readSnippet(repoDir, {
    checkId: "r",
    path: "src/server.js",
    line: 13,
    endLine: 13,
    message: "",
    severity: "ERROR",
    cwe: [],
    snippet: "",
  })
  assert.match(snippet, /^> {3}13 \| .*eval\(req\.body\.expression\)/m)
  assert.match(snippet, /^ {4}12 \| /m)
})

test("readSnippet returns empty rather than throwing when the file is gone", async () => {
  const snippet = await readSnippet(repoDir, {
    checkId: "r",
    path: "src/nope.js",
    line: 1,
    endLine: 1,
    message: "",
    severity: "ERROR",
    cwe: [],
    snippet: "",
  })
  assert.equal(snippet, "")
})

// --------------------------------------------------------------------------
// triage: the prompt and the answer
// --------------------------------------------------------------------------

test("triageMessages gives the model the rule, the weakness and the code", () => {
  const c: AnalysisCandidate = {
    checkId: "js-eval-any",
    path: "src/server.js",
    line: 13,
    endLine: 13,
    message: "eval() on a value.",
    severity: "WARNING",
    cwe: ["CWE-95: x"],
    snippet: "",
    vulnerabilityId: "CWE-95",
    ruleIds: ["js-eval-any"],
  }
  const [system, user] = triageMessages(c, "> 13 | eval(req.body.x)")
  assert.match(system?.content ?? "", /real|noise/)
  assert.match(user?.content ?? "", /CWE-95/)
  assert.match(user?.content ?? "", /src\/server\.js lines 13-13/)
  assert.match(user?.content ?? "", /eval\(req\.body\.x\)/)
})

test("parseTriage reads the verdict out of a JSON answer, with or without prose", () => {
  assert.deepEqual(parseTriage('{"verdict":"real","reason":"user input reaches eval"}'), {
    verdict: "real",
    reason: "user input reaches eval",
  })
  assert.deepEqual(parseTriage('Sure!\n{"verdict":"noise","reason":"a constant"}\nHope that helps.'), {
    verdict: "noise",
    reason: "a constant",
  })
})

test("parseTriage treats anything but a clear real as noise", () => {
  // A Finding the model did not clearly confirm is the noise this task drops.
  assert.equal(parseTriage('{"verdict":"maybe","reason":"unsure"}').verdict, "noise")
  assert.equal(parseTriage("I could not tell.").verdict, "noise")
  assert.equal(parseTriage("{not json").verdict, "noise")
  assert.match(parseTriage("I could not tell.").reason, /not the expected JSON/)
})

test("findingSeverity maps semgrep's level onto the Finding scale", () => {
  assert.equal(findingSeverity("ERROR"), "high")
  assert.equal(findingSeverity("WARNING"), "medium")
  assert.equal(findingSeverity("INFO"), "low")
})

// --------------------------------------------------------------------------
// the Finding
// --------------------------------------------------------------------------

test("candidateFinding names the Vulnerability, the place and the model's reason", async () => {
  const c = dedupeCandidates(await recordedCandidates())[0]
  assert.ok(c)
  const triage: Triage = { verdict: "real", reason: "req.body.expression reaches eval" }
  const f = candidateFinding(c, triage, "> 13 | eval(req.body.expression)", {
    missionId: "m-1",
    repository: "https://gitlab.com/examplebank/customer-portal",
    commit: "abc1234",
    targetId: "t-1",
  })

  assert.match(f.title, /^CWE-95 at src\/server\.js:13/)
  assert.equal(f.severity, "high")
  assert.equal(f.mission_id, "m-1")
  assert.equal(f.agent_name, "zerocool")
  assert.equal(f.target_id, "t-1")
  // The typed SubmitFinding mapping carries no free-form metadata, so the
  // Vulnerability id and the place have to survive in the tags.
  assert.ok(f.tags?.includes("vulnerability:CWE-95"))
  assert.ok(f.tags?.includes("file:src/server.js"))
  assert.ok(f.tags?.includes("line:13"))
  assert.ok(f.tags?.includes("source-analysis"))
  assert.ok(f.tags?.includes("commit:abc1234"))
  assert.match(f.description, /Triage: req\.body\.expression reaches eval/)
  assert.match(f.description, /customer-portal @ abc1234/)
  assert.equal(f.evidence?.[0]?.content, "> 13 | eval(req.body.expression)")
})

// --------------------------------------------------------------------------
// a whole pass
// --------------------------------------------------------------------------

test("a pass over the fixture submits one Finding per real weakness and drops the false positive", async () => {
  const findings = recordingFindings()
  const summary = await runSourceAnalysis({
    dir: repoDir,
    model: stubModel,
    findings,
    semgrep: async () => await recordedCandidates(),
    provenance: { missionId: "m-1", repository: "https://gitlab.com/examplebank/customer-portal", commit: "abc1234" },
  })

  assert.equal(summary.matches, 4)
  assert.equal(summary.candidates, 3)
  assert.equal(summary.real, 2)
  assert.equal(summary.noise, 1)
  assert.equal(summary.failed.length, 0)

  // Exactly two Findings, one per real weakness, and NOTHING else.
  assert.equal(findings.submitted.length, 2)
  assert.equal(summary.findingIds.length, 2)
  assert.deepEqual(
    findings.submitted.map((f) => f.tags?.find((t) => t.startsWith("line:"))),
    REAL_LINES.map((l) => `line:${l}`),
  )
  assert.deepEqual(
    findings.submitted.map((f) => f.tags?.find((t) => t.startsWith("vulnerability:"))),
    ["vulnerability:CWE-95", "vulnerability:CWE-78"],
  )

  // The dropped one is recorded with the model's reason, not silently gone.
  const dropped = summary.verdicts.find((v) => v.verdict === "noise")
  assert.ok(dropped)
  assert.match(dropped.candidate, /src\/server\.js:26/)
  assert.match(dropped.reason, /string literal/)
  assert.equal(summary.verdicts.length, 3)
})

test("a pass changes no file in the checkout", async () => {
  // The task reads and submits. Changing the repository is the Fix's job
  // (zerocool-plugins#89), a different task with a different grant posture.
  const before = await treeSnapshot(repoDir)
  await runSourceAnalysis({
    dir: repoDir,
    model: stubModel,
    findings: recordingFindings(),
    semgrep: async () => await recordedCandidates(),
  })
  assert.deepEqual(await treeSnapshot(repoDir), before)
})

test("a pass over a clean checkout submits nothing and does not throw", async () => {
  const findings = recordingFindings()
  const summary = await runSourceAnalysis({
    dir: repoDir,
    model: stubModel,
    findings,
    semgrep: async () => [],
  })
  assert.equal(summary.candidates, 0)
  assert.equal(findings.submitted.length, 0)
})

test("a scan that could not run fails the pass rather than reporting a clean checkout", async () => {
  await assert.rejects(
    runSourceAnalysis({
      dir: repoDir,
      model: stubModel,
      findings: recordingFindings(),
      semgrep: async () => {
        throw new Error("semgrep exited 2: rule parse error")
      },
    }),
    /rule parse error/,
  )
})

test("one bad model answer costs one candidate, not the whole scan", async () => {
  const findings = recordingFindings()
  const summary = await runSourceAnalysis({
    dir: repoDir,
    model: async (c, snippet) => {
      if (c.line === 13) throw new Error("model timed out")
      return await stubModel(c, snippet)
    },
    findings,
    semgrep: async () => await recordedCandidates(),
  })

  assert.equal(summary.failed.length, 1)
  assert.match(summary.failed[0]?.error ?? "", /triage: model timed out/)
  // Line 19 is still triaged and submitted.
  assert.equal(findings.submitted.length, 1)
  assert.equal(summary.real, 1)
})

test("a refused submit is recorded, never swallowed", async () => {
  const summary = await runSourceAnalysis({
    dir: repoDir,
    model: stubModel,
    findings: {
      submit: async () => {
        throw new Error("SubmitFinding refused: permission denied")
      },
      describe: () => "refusing backend",
    },
    semgrep: async () => await recordedCandidates(),
  })
  assert.equal(summary.real, 2)
  assert.equal(summary.findingIds.length, 0)
  assert.equal(summary.failed.length, 2)
  assert.match(summary.failed[0]?.error ?? "", /submit: SubmitFinding refused/)
})

test("the pass emits a progress event per step for the console stream", async () => {
  const phases: string[] = []
  await runSourceAnalysis({
    dir: repoDir,
    model: stubModel,
    findings: recordingFindings(),
    semgrep: async () => await recordedCandidates(),
    onEvent: (e) => phases.push(String(e.phase)),
  })
  assert.deepEqual(phases, [
    "semgrep",
    "candidates",
    "triage",
    "submit",
    "triage",
    "submit",
    "triage",
    "done",
  ])
})

test("formatSourceAnalysis states the counts and every verdict", async () => {
  const summary = await runSourceAnalysis({
    dir: repoDir,
    model: stubModel,
    findings: recordingFindings(),
    semgrep: async () => await recordedCandidates(),
  })
  const text = formatSourceAnalysis(summary)
  assert.match(text, /4 semgrep matches, 3 candidates, 2 real, 1 noise, 2 findings submitted, 0 failed/)
  assert.match(text, /- real .*src\/server\.js:13 CWE-95/)
  assert.match(text, /- noise .*src\/server\.js:26 CWE-95/)
})

// --------------------------------------------------------------------------
// dispatch routing
// --------------------------------------------------------------------------

// Built through the real reader, so the fixture cannot drift from the launcher
// contract: the task context arrives as gibson marshals it, TypedValue-wrapped.
const sourceAnalysisCtx = (): DispatchContext =>
  readDispatchContext(
    {
      GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
      GIBSON_CG_JWT: "task-tok",
      GIBSON_CALLBACK_INSECURE: "1",
      GIBSON_MISSION_ID: "m-1",
      GIBSON_MISSION_RUN_ID: "run-1",
      GIBSON_AGENT_RUN_ID: "agent-1",
      GIBSON_AGENT_TASK_B64: Buffer.from(
        JSON.stringify({
          goal: "analyze the checkout for source weaknesses",
          context: {
            "zerocool.task": { stringValue: "source-analysis" },
            "repository.url": { stringValue: "https://gitlab.com/examplebank/customer-portal" },
            "repository.commit": { stringValue: "abc1234" },
            "target.id": { stringValue: "t-1" },
          },
        }),
        "utf8",
      ).toString("base64"),
    },
    { cwd: repoDir },
  )

test("a source-analysis task runs the analysis and never spawns opencode", async () => {
  const findings = recordingFindings()
  let opencodeRuns = 0

  const outcome = await runDispatch(sourceAnalysisCtx(), {
    run: async () => {
      opencodeRuns += 1
      throw new Error("opencode must not run for a source-analysis task")
    },
    semgrep: async () => await recordedCandidates(),
    model: stubModel,
    findings,
  })

  assert.equal(opencodeRuns, 0)
  assert.equal(outcome.success, true)
  assert.equal(findings.submitted.length, 2)
  assert.equal(outcome.findingIds?.length, 2)
  assert.equal(outcome.metadata?.task, "source-analysis")
  assert.equal(outcome.metadata?.submitted, "2")
  assert.equal(outcome.metadata?.noise, "1")
  assert.match(String(outcome.output), /2 real, 1 noise/)
  // Provenance from the task context reaches the Finding.
  assert.ok(findings.submitted[0]?.tags?.includes("commit:abc1234"))
  assert.equal(findings.submitted[0]?.mission_id, "m-1")
  assert.equal(findings.submitted[0]?.target_id, "t-1")
})

test("a source-analysis task scans source.path under the workspace when the node set one", async () => {
  let scanned = ""
  await runDispatch(
    { ...sourceAnalysisCtx(), workspace: fixtureDir, taskContext: { ...sourceAnalysisCtx().taskContext, "source.path": "repo" } },
    {
      semgrep: async (opts) => {
        scanned = opts.dir
        return []
      },
      model: stubModel,
      findings: recordingFindings(),
    },
  )
  assert.equal(scanned, join(fixtureDir, "repo"))
})

test("a dispatch with no task selector still drives opencode", async () => {
  let ran = 0
  const outcome = await runDispatch(
    { ...sourceAnalysisCtx(), taskContext: {} },
    {
      run: async () => {
        ran += 1
        return {
          sessionId: "ses_1",
          text: "done",
          finishReason: "stop",
          tokens: { total: 10, input: 8, output: 2, reasoning: 0 },
          cost: 0.01,
          events: 2,
        }
      },
    },
  )
  assert.equal(ran, 1)
  assert.equal(outcome.success, true)
  assert.equal(outcome.metadata?.task, undefined)
})
