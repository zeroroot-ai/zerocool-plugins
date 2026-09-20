// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { claudeChildEnv, defaultStateDir, ensureStateDir, MEMBER_ENV, readMemberEnv, SANDBOX_STATE_DIR } from "./env.js"

const launch: NodeJS.ProcessEnv = {
  GIBSON_MEMBER_ID: "mem-1",
  GIBSON_BANK_ID: "bank-1",
  GIBSON_CG_JWT: "base-grant",
  GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
  GIBSON_SANDBOX: "gvisor",
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
  assert.equal(env.stateDir, SANDBOX_STATE_DIR, "under the sandbox the state dir is the scratch path, never the home dir")
  assert.equal(env.claudeConfigDir, join(SANDBOX_STATE_DIR, "claude-config"))
})

test("the state dir defaults to the sandbox scratch path under the marker, and to the home dir elsewhere", () => {
  assert.equal(SANDBOX_STATE_DIR, "/tmp/zerocool")
  assert.equal(defaultStateDir({ GIBSON_SANDBOX: "gvisor" }), "/tmp/zerocool")
  assert.equal(defaultStateDir({}), join(homedir(), ".zerocool"))
  assert.equal(defaultStateDir({ GIBSON_SANDBOX: "docker" }), join(homedir(), ".zerocool"))
  assert.equal(readMemberEnv({ ...launch, ZEROCOOL_STATE_DIR: "/data/state" }).stateDir, "/data/state", "an explicit value wins")
  assert.equal(readMemberEnv({ ...launch, ZEROCOOL_STATE_DIR: "" }).stateDir, "/tmp/zerocool", "an empty value is unset")
})

test("the state dir is created and proven writable before anything is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-state-"))
  try {
    const nested = join(dir, "a", "b")
    await ensureStateDir(nested)
    assert.ok((await stat(nested)).isDirectory())
    await ensureStateDir(nested)
    // A path under a file cannot be a directory, on any account, root included.
    const file = join(dir, "file")
    await writeFile(file, "")
    await assert.rejects(ensureStateDir(join(file, "zerocool")), (e: Error) => {
      assert.match(e.message, /^ZEROCOOL_STATE_DIR: cannot write to .*\/file\/zerocool \(ENOTDIR\)/)
      assert.match(e.message, /Under the sandbox that is \/tmp\/zerocool/)
      assert.ok(!e.message.includes("\n"), "one line")
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a launch with no member, bank, grant, endpoint or sandbox marker fails with the reason", () => {
  for (const key of Object.values({ m: "GIBSON_MEMBER_ID", b: "GIBSON_BANK_ID", g: "GIBSON_CG_JWT", e: "GIBSON_CALLBACK_ENDPOINT", s: "GIBSON_SANDBOX" })) {
    const broken = { ...launch }
    delete broken[key]
    assert.throws(() => readMemberEnv(broken), new RegExp(`${key} is not set`), `${key} must be required`)
  }
})

test("the sandbox marker must say gvisor: any other value refuses to start", () => {
  assert.throws(() => readMemberEnv({ ...launch, GIBSON_SANDBOX: "docker" }), /GIBSON_SANDBOX is "docker", expected "gvisor"/)
  assert.throws(() => readMemberEnv({ ...launch, GIBSON_SANDBOX: "" }), /GIBSON_SANDBOX is ""/)
  assert.equal(readMemberEnv(launch).sandbox, "gvisor")
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
      GIBSON_SANDBOX: "gvisor",
      GIBSON_TURN_TOKEN: "turn-token-of-this-driver",
      ZEROCOOL_MCP_URL: "http://127.0.0.1:7455/mcp",
      GIT_ASKPASS: "/state/git-askpass.sh",
      ZEROCOOL_GIT_TOKEN: "glpat-secret",
      SOME_OTHER_SECRET: "nope",
    },
    { CLAUDE_CONFIG_DIR: "/state/claude-config" },
  )
  assert.equal(child.GIBSON_CG_JWT, undefined)
  assert.equal(child.GIBSON_CALLBACK_ENDPOINT, undefined)
  assert.equal(child.GIBSON_TURN_TOKEN, undefined, "the /turn bearer token stays in the driver")
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
