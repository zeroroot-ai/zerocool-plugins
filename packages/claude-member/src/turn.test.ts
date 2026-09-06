// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import type { ClaudeRunOptions } from "./claude-run.js"
import { readMemberEnv } from "./env.js"
import type { McpGateway } from "./inbox.js"
import type { JobRecord, JobSpec } from "./job.js"
import { startTurn, turnOptions } from "./turn.js"

const env = readMemberEnv({
  GIBSON_MEMBER_ID: "mem-1",
  GIBSON_BANK_ID: "bank-1",
  GIBSON_CG_JWT: "base-grant",
  GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
  ZEROCOOL_CLAUDE_MODEL: "claude-opus-4-6",
  ZEROCOOL_STATE_DIR: "/state",
})

const spec: JobSpec = {
  jobId: "job-42",
  goal: "fix the route",
  repositories: [],
  credentialNames: [],
  inputNodeIds: [],
  acceptance: "",
  constraints: { maxTurns: 12, maxBudgetUsd: 3 },
}

function job(over: Partial<JobRecord> = {}): JobRecord {
  return { jobId: "job-42", state: "open", spec, claudeSessionId: "", worktrees: {}, openedAt: 0, lastActivityAt: 0, turns: 0, costUsd: 0, recovered: false, ...over }
}

const gateway = (): McpGateway & { grants: [string, string][]; released: string[] } => {
  const grants: [string, string][] = []
  const released: string[] = []
  return {
    url: "http://127.0.0.1:7455/mcp",
    useGrant: async (j: string, g: string) => void grants.push([j, g]),
    release: async (j: string) => void released.push(j),
    grants,
    released,
  }
}

test("the first turn omits --resume; the next turn resumes the recorded session", () => {
  const worktrees = [{ repository: "api", path: "/workspace/jobs/job-42/api", branch: "job/job-42", deliverable: "MERGE_REQUEST" as const }]
  const first = turnOptions({ job: job(), text: "start", grant: "turn-grant", worktrees, cwd: worktrees[0]!.path }, { env, processEnv: {}, mcp: gateway() })
  assert.equal(first.resume, undefined)
  const second = turnOptions({ job: job({ claudeSessionId: "sess-7", state: "waiting" }), text: "again", grant: "turn-grant", worktrees, cwd: worktrees[0]!.path }, { env, processEnv: {}, mcp: gateway() })
  assert.equal(second.resume, "sess-7")
})

test("the job's constraints win over the member defaults", () => {
  const o = turnOptions({ job: job(), text: "x", grant: "g", worktrees: [], cwd: "/w" }, { env, processEnv: {}, mcp: undefined })
  assert.equal(o.maxTurns, 12)
  assert.equal(o.maxBudgetUsd, 3)
  assert.equal(o.model, "claude-opus-4-6")
  assert.equal(o.sessionPersistence, true)
})

test("the MCP gateway is attached over localhost HTTP with the ask tool as the permission prompt", () => {
  const g = gateway()
  const o = turnOptions({ job: job(), text: "x", grant: "g", worktrees: [], cwd: "/w" }, { env, processEnv: {}, mcp: g })
  assert.deepEqual(o.mcpServers?.gibson, { type: "http", url: "http://127.0.0.1:7455/mcp" })
  assert.equal(o.permissionPromptTool, "mcp__gibson__ask")
  assert.deepEqual(o.allowedTools, ["mcp__gibson__*"])
})

test("the turn's own grant reaches the gateway before the run and is released after it", async () => {
  const g = gateway()
  let seen: ClaudeRunOptions | undefined
  const handle = await startTurn(
    { job: job(), text: "x", grant: "turn-grant-of-this-dispatch", worktrees: [], cwd: "/w" },
    {
      env,
      processEnv: {},
      mcp: g,
      spawn: (o) => {
        seen = o
        return { done: Promise.resolve({ text: "", sessionId: "s", isError: false, resultSubtype: "success", numTurns: 1, costUsd: 0, mcpServerErrors: [], toolCalls: [], events: 1, sawResult: true, stderr: "", exitCode: 0, signal: null }), interrupt: () => {}, kill: () => {}, pid: 1 }
      },
    },
  )
  assert.deepEqual(g.grants, [["job-42", "turn-grant-of-this-dispatch"]], "every input runs under the grant of its own dispatch")
  await handle.done
  assert.deepEqual(g.released, ["job-42"])
  assert.equal(seen?.input, "x")
})

test("the child environment carries no grant, whatever the driver holds", () => {
  const o = turnOptions({ job: job(), text: "x", grant: "turn-grant", worktrees: [], cwd: "/w" }, { env, processEnv: { GIBSON_CG_JWT: "base-grant", PATH: "/usr/bin" }, mcp: gateway() })
  assert.equal(o.env?.GIBSON_CG_JWT, undefined)
  assert.equal(o.env?.CLAUDE_CONFIG_DIR, "/state/claude-config")
})
