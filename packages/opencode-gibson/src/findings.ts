// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Finding, TaskHarness } from "@zeroroot-ai/sdk"

/**
 * Findings — emit what the agent discovers into the tenant World
 * (zerocool-plugins#7).
 *
 * One code path, one backend: the callback service's `SubmitFinding` under
 * the per-dispatch grant. The component-identity backend and the standalone
 * JSONL log went with the `submit_finding` tool (ADR-0008): a model submits
 * through the Gibson MCP server, and nothing in this package submits on a
 * component identity or to a local file (zerocool-plugins#102).
 *
 * The agent decides what is a finding. Nothing here invents findings from file
 * edits or message traffic: a `file.edited` event is not a security finding, and
 * auto-emitting one would fill the tenant graph with noise that a human then has
 * to triage.
 *
 * The `submit_finding` tool the model calls lives in the Gibson MCP server now
 * (ADR-0008). What is left here is the backend the dispatched task kinds use
 * when they submit a finding themselves, with no model in the loop:
 * `source-analysis` triages semgrep candidates, and `dispatch` reports them
 * under the task grant.
 */

export interface FindingsBackend {
  /** Submit a finding; returns the identifier it was recorded under. */
  submit(f: Finding): Promise<string>
  /** Where findings go, for the tool's result message. */
  describe(): string
}

/**
 * Task backend — the callback service's typed `SubmitFinding` under the
 * per-dispatch grant, so a sandboxed run's findings are attributed to the TASK
 * (mission and run), never to a component identity the sandbox does not hold.
 * Fields map from the SDK's JSON finding onto `gibson.types.v1.Finding`; the
 * daemon keeps the id `newFinding` minted. Same mapping as claude-gibson's.
 */
export function taskFindingsBackend(harness: TaskHarness): FindingsBackend {
  const severity = (s: string): number => ({ critical: 1, high: 2, medium: 3, low: 4, info: 5 })[s] ?? 0
  return {
    submit: async (f) => {
      const res = await harness.client.submitFinding({
        context: harness.context,
        finding: {
          id: f.id,
          missionId: f.mission_id,
          agentName: f.agent_name,
          title: f.title,
          description: f.description,
          category: f.category,
          severity: severity(f.severity),
          confidence: f.confidence,
          remediation: f.remediation ?? "",
          targetId: f.target_id ?? "",
          tags: f.tags ?? [],
          references: f.references ?? [],
          evidence: (f.evidence ?? []).map((e) => ({ type: e.type, title: e.title, content: e.content })),
        } as never,
      })
      if (res.error) throw new Error(`SubmitFinding refused: ${res.error.message}`)
      return f.id
    },
    describe: () => "the tenant Gibson graph (dispatch grant)",
  }
}

/** Provenance stamped onto every finding this session emits. */
export interface SessionContext {
  /** opencode session ID, recorded as the finding's mission correlation. */
  sessionID?: string
}
