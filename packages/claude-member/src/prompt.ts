// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { JobSpec } from "./job.js"
import type { Worktree } from "./workspace.js"

/**
 * The system prompt block appended to every turn (zerocool-plugins#106).
 * It tells Claude the job id, the goal, the worktree paths, the deliverable
 * declared for each repository, the credential names the turn may fetch, and
 * the one rule about pushing. The platform pushes at wrap-up under the base
 * grant, so Claude never holds a token (glossary, Permission posture).
 */
export function turnSystemPrompt(spec: JobSpec, worktrees: Worktree[]): string {
  const lines: string[] = []
  lines.push(`You run inside a Gibson member sandbox on job ${spec.jobId}.`)
  lines.push(`Goal: ${spec.goal}`)
  if (spec.acceptance) lines.push(`Acceptance: ${spec.acceptance}`)
  if (worktrees.length > 0) {
    lines.push("Worktrees (one per repository, already checked out on the job branch):")
    for (const w of worktrees) lines.push(`- ${w.repository}: ${w.path} on branch ${w.branch}, deliverable ${w.deliverable}`)
  }
  if (spec.inputNodeIds.length > 0) lines.push(`Input World nodes: ${spec.inputNodeIds.join(", ")}`)
  if (spec.credentialNames.length > 0) {
    lines.push(`Credentials you may fetch through the get_credential tool: ${spec.credentialNames.join(", ")}. No other name is granted.`)
  }
  lines.push("Commit on the job branch. Never push. The platform pushes and opens the merge request at wrap-up.")
  lines.push("Record every real security finding with submit_finding. Ask a person through the ask tool when you are blocked.")
  lines.push("A scorer closes this job. Do not stop early because you think it is done: state the outcome and wait for the next input.")
  return lines.join("\n")
}
