// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runHook } from "./hook-run.js"
import { writeFile } from "node:fs/promises"
import { keyFor } from "./state.js"

test("SessionStart injects the ambient block the server handed off, and nothing when there is none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zc-hook-"))
  const env = { ZEROCOOL_STATE_DIR: dir }
  assert.equal(await runHook({ hook_event_name: "SessionStart", cwd: "/w" }, env), "")
  await writeFile(join(dir, `ambient-${keyFor("/w")}.md`), "Prior context: x", "utf8")
  const out = JSON.parse(await runHook({ hook_event_name: "SessionStart", cwd: "/w" }, env)) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart")
  assert.equal(out.hookSpecificOutput.additionalContext, "Prior context: x")
})

test("SessionEnd with no live mission is a no-op, and an unknown event prints nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zc-hook-"))
  const env = { ZEROCOOL_STATE_DIR: dir }
  assert.equal(await runHook({ hook_event_name: "SessionEnd", cwd: "/w", session_id: "s", transcript_path: "/none" }, env), "")
  assert.equal(await runHook({ hook_event_name: "PreToolUse", cwd: "/w" }, env), "")
})
