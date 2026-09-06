// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { claudeChildEnv, MEMBER_ENV, readMemberEnv } from "./env.js"

const launch: NodeJS.ProcessEnv = {
  GIBSON_MEMBER_ID: "mem-1",
  GIBSON_BANK_ID: "bank-1",
  GIBSON_CG_JWT: "base-grant",
  GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
}

test("readMemberEnv reads the launch contract and defaults the rest", () => {
  const env = readMemberEnv(launch)
  assert.equal(env.memberId, "mem-1")
  assert.equal(env.bankId, "bank-1")
  assert.equal(env.baseGrant, "base-grant")
  assert.equal(env.instanceMode, "member")
  assert.equal(env.loginShape, "api-key")
  assert.equal(env.jobCap, 1)
  assert.equal(env.workspace, "/workspace")
  assert.equal(env.workspaceCapBytes, 20 * 1024 * 1024 * 1024)
  assert.equal(env.maxTurns, 200)
  assert.equal(env.maxBudgetUsd, undefined)
  assert.equal(env.staleLimitMs, 24 * 60 * 60 * 1000)
})

test("a launch with no member, bank, grant or endpoint fails with the reason", () => {
  for (const key of Object.values({ m: "GIBSON_MEMBER_ID", b: "GIBSON_BANK_ID", g: "GIBSON_CG_JWT", e: "GIBSON_CALLBACK_ENDPOINT" })) {
    const broken = { ...launch }
    delete broken[key]
    assert.throws(() => readMemberEnv(broken), new RegExp(`${key} is not set`), `${key} must be required`)
  }
})

test("an unknown instance mode or login shape is refused, never guessed", () => {
  assert.throws(() => readMemberEnv({ ...launch, [MEMBER_ENV.instanceMode]: "sometimes" }), /member or one-shot/)
  assert.throws(() => readMemberEnv({ ...launch, [MEMBER_ENV.loginShape]: "oauth" }), /must be one of/)
})

test("a cap that is not a positive integer is refused", () => {
  assert.throws(() => readMemberEnv({ ...launch, [MEMBER_ENV.jobCap]: "0" }), /positive integer/)
  assert.throws(() => readMemberEnv({ ...launch, [MEMBER_ENV.jobCap]: "two" }), /positive integer/)
  assert.equal(readMemberEnv({ ...launch, [MEMBER_ENV.jobCap]: "4" }).jobCap, 4)
})

test("the Claude child never sees a Gibson grant, a zerocool knob or a git token", () => {
  const child = claudeChildEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/claude",
      ANTHROPIC_API_KEY: "sk-ant-tenant",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock",
      GIBSON_CG_JWT: "base-grant",
      GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
      ZEROCOOL_MCP_URL: "http://127.0.0.1:7455/mcp",
      GIT_ASKPASS: "/state/git-askpass.sh",
      ZEROCOOL_GIT_TOKEN: "glpat-secret",
      SOME_OTHER_SECRET: "nope",
    },
    { CLAUDE_CONFIG_DIR: "/state/claude-config" },
  )
  assert.equal(child.GIBSON_CG_JWT, undefined)
  assert.equal(child.GIBSON_CALLBACK_ENDPOINT, undefined)
  assert.equal(child.ZEROCOOL_MCP_URL, undefined)
  assert.equal(child.ZEROCOOL_GIT_TOKEN, undefined)
  assert.equal(child.GIT_ASKPASS, undefined)
  assert.equal(child.SOME_OTHER_SECRET, undefined, "the allow list drops what it does not name")
  assert.equal(child.ANTHROPIC_API_KEY, "sk-ant-tenant", "Claude Code reads its own credential")
  assert.equal(child.AWS_BEARER_TOKEN_BEDROCK, "bedrock")
  assert.equal(child.CLAUDE_CONFIG_DIR, "/state/claude-config")
  assert.equal(child.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", "one job's memory must not reach another job")
  assert.equal(child.PATH, "/usr/bin")
})
