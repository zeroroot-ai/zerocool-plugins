// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { JobSpec } from "./job.js"
import type { Worktree } from "./workspace.js"

/**
 * The system prompt block appended to every turn (zerocool-plugins#106).
 * It tells Claude the job id, the goal, the worktree paths, the deliverable
 * declared for each repository, the credential names the turn may fetch, and
 * the limits of the delivery. The platform opens the merge request at wrap-up
 * through the connector tool, so Claude never holds a token (glossary,
 * Permission posture).
 */
export function turnSystemPrompt(spec: JobSpec, worktrees: Worktree[]): string {
  const lines: string[] = []
  lines.push(`You run inside a Gibson member sandbox on job ${spec.jobId}.`)
  lines.push(`Goal: ${spec.goal}`)
  if (spec.acceptance) lines.push(`Acceptance: ${spec.acceptance}`)
  if (worktrees.length > 0) {
    lines.push("Worktrees (one per repository, already checked out on the job branch):")
    for (const w of worktrees) lines.push(`- ${w.repository}: ${w.path} on branch ${w.branch}, deliverable ${w.deliverable}`)
    lines.push(
      "The worktrees are sparse: each holds only the files the job names. Before you change another file that exists in the repository, call the tool mcp__workspace__fetch_file with its path, then edit the file in the worktree. A new file needs no call.",
    )
    for (const w of worktrees) for (const n of w.notes) lines.push(`Note for ${w.repository}: ${n}`)
  }
  if (spec.inputNodeIds.length > 0) lines.push(`Input World nodes: ${spec.inputNodeIds.join(", ")}`)
  if (spec.credentialNames.length > 0) {
    lines.push(`Credentials you may fetch through the get_credential tool: ${spec.credentialNames.join(", ")}. No other name is granted.`)
  }
  lines.push("Never push: the worktree has no remote and no token. The platform opens one merge request from the files of the worktree at wrap-up. Committing is not needed.")
  lines.push("The merge request takes at most 100 changed files, 1 MiB for one file and 8 MiB in all, as UTF-8 text. Do not change a file mode, and do not add an executable file or a symbolic link. Keep the change inside these limits.")
  lines.push("Record every real security finding with submit_finding. Ask a person through the ask tool when you are blocked.")
  lines.push("A scorer closes this job. Do not stop early because you think it is done: state the outcome and wait for the next input.")
  return lines.join("\n")
}
