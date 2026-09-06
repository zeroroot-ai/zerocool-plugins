// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { spawnClaude, type ClaudeHandle, type ClaudeRunOptions, type ClaudeRunResult } from "./claude-run.js"
import { claudeChildEnv, type MemberEnv } from "./env.js"
import type { ClaudeEvent } from "./events.js"
import type { McpGateway } from "./inbox.js"
import type { JobRecord } from "./job.js"
import { turnSystemPrompt } from "./prompt.js"
import type { Worktree } from "./workspace.js"

/**
 * One turn of one job (zerocool-plugins#105).
 *
 * Spawns `claude -p --input-format stream-json ...` with the job's Claude
 * Code session resumed, the localhost Gibson MCP server attached under this
 * turn's grant, and the workspace prompt appended. Writes the input as one
 * stream-json user message, closes stdin, and forwards every event.
 *
 * On `result` the caller records the cost and the session id and marks the
 * job `waiting`. Idle jobs hold no process.
 */
export interface TurnRequest {
  job: JobRecord
  text: string
  grant: string
  worktrees: Worktree[]
  /** The cwd of the process. The first worktree, or the job dir when there is none. */
  cwd: string
}

export interface TurnDeps {
  env: MemberEnv
  processEnv: NodeJS.ProcessEnv
  mcp: McpGateway | undefined
  onEvent?: (jobId: string, line: string, event: ClaudeEvent | undefined) => void
  spawn?: typeof spawnClaude
}

export interface TurnHandle {
  jobId: string
  done: Promise<ClaudeRunResult>
  interrupt(): void
  kill(): void
}

/** Build the run options for one turn. Pure, so the argv is testable. */
export function turnOptions(req: TurnRequest, deps: TurnDeps): ClaudeRunOptions {
  const { env } = deps
  const spec = req.job.spec
  const opts: ClaudeRunOptions = {
    input: req.text,
    cwd: req.cwd,
    appendSystemPrompt: turnSystemPrompt(spec, req.worktrees),
    maxTurns: spec.constraints.maxTurns ?? env.maxTurns,
    sessionPersistence: true,
    bin: env.claudeBin,
    env: claudeChildEnv(deps.processEnv, { CLAUDE_CONFIG_DIR: env.claudeConfigDir }),
  }
  const budget = spec.constraints.maxBudgetUsd ?? env.maxBudgetUsd
  if (budget) opts.maxBudgetUsd = budget
  if (env.model) opts.model = env.model
  if (req.job.claudeSessionId) opts.resume = req.job.claudeSessionId
  if (deps.mcp) {
    opts.mcpServers = { gibson: { type: "http", url: deps.mcp.url } }
    opts.allowedTools = ["mcp__gibson__*"]
    opts.permissionPromptTool = "mcp__gibson__ask"
  }
  return opts
}

/**
 * Start the turn. The grant is put in force before Claude Code starts, so no
 * tool call can run under the wrong dispatch's grant, and released after.
 */
export async function startTurn(req: TurnRequest, deps: TurnDeps): Promise<TurnHandle> {
  const jobId = req.job.jobId
  await deps.mcp?.useGrant(jobId, req.grant)
  const opts = turnOptions(req, deps)
  if (deps.onEvent) {
    const on = deps.onEvent
    opts.onEvent = (line, event) => on(jobId, line, event)
  }
  const handle: ClaudeHandle = (deps.spawn ?? spawnClaude)(opts)
  const done = handle.done.finally(async () => {
    await deps.mcp?.release(jobId)
  })
  return { jobId, done, interrupt: () => handle.interrupt(), kill: () => handle.kill() }
}
