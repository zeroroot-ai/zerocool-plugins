// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { Watcher, type AgentOutcome } from "@zeroroot-ai/sdk"
import { readDispatchContext, runForkableDispatch } from "./dispatch.js"

/** The opencode dispatch as a fork source (D74). */

const b64 = (goal: string) => Buffer.from(JSON.stringify({ id: "t", goal })).toString("base64")
const launch = (goal: string) => ({
  GIBSON_CG_JWT: "grant",
  GIBSON_CALLBACK_ENDPOINT: "d:50001",
  GIBSON_AGENT_TASK_B64: b64(goal),
})

test("a fork source parks after a passing run, and a fork runs the task of its claim", async () => {
  const goals: string[] = []
  const results: unknown[] = []
  const parent = launch("scan the first host")
  await runForkableDispatch(readDispatchContext(parent), parent, {
    watcher: Watcher.withReader(() => "sbx"),
    runOnce: async (ctx) => {
      goals.push(ctx.goal)
      return { success: true, output: ctx.goal } as AgentOutcome
    },
    park: async (env) => (env === parent ? launch("scan the next host") : undefined),
    onOutcome: (o) => results.push(o.output),
  })
  assert.deepEqual(goals, ["scan the first host", "scan the next host"])
  assert.deepEqual(results, ["scan the first host", "scan the next host"], "each run writes its result line")
})

test("a failed run does not park, and the parent ends after the park", async () => {
  let parks = 0
  const parent = launch("scan")
  const failed = await runForkableDispatch(readDispatchContext(parent), parent, {
    watcher: Watcher.withReader(() => "sbx"),
    runOnce: async () => ({ success: false }) as AgentOutcome,
    park: async () => {
      parks++
      return undefined
    },
  })
  assert.equal(failed.success, false)
  assert.equal(parks, 0)
  const passed = await runForkableDispatch(readDispatchContext(parent), parent, {
    watcher: Watcher.withReader(() => "sbx"),
    runOnce: async () => ({ success: true }) as AgentOutcome,
    park: async () => {
      parks++
      return undefined
    },
  })
  assert.equal(passed.success, true)
  assert.equal(parks, 1)
})
