// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { EXTENSION_KEY, startAgentWorker, type InstanceRef } from "@zeroroot-ai/sdk"
import type { OpencodeRunOptions, OpencodeRunResult } from "./opencode-run.js"
import { agentHandler } from "./serve-agent.js"

/** The agent worker submits an A2A Task. These tests drive the real SDK worker with a fake daemon. */

const message = (goal: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      messageId: "m-1",
      taskId: "t-1",
      contextId: "c-1",
      role: "ROLE_USER",
      parts: [{ text: goal }],
      metadata: { [EXTENSION_KEY]: { mission_run_id: "run-1", agent_run_id: "ar-1", trace_id: "tr-1" } },
    }),
  )

interface Submitted {
  workId: string
  result: Uint8Array
  error?: { code: string; message: string }
}

/** Serve one work item, and return what the worker submitted for it. */
async function serve(
  goal: string,
  handler: Parameters<typeof startAgentWorker>[2]["handler"],
): Promise<{ submitted: Submitted; task: { id?: string; contextId?: string; status?: { state?: string }; metadata?: Record<string, unknown> } }> {
  let served = false
  let done!: (s: Submitted) => void
  const submittedP = new Promise<Submitted>((r) => (done = r))
  const component = {
    pollWork: async () => {
      if (served) return await new Promise<never>(() => {})
      served = true
      return { workId: "w-1", workType: "execute", context: {}, payload: message(goal), timeoutMs: 0n, taskGrant: "grant" }
    },
    submitResult: async (r: Submitted) => done(r),
  } as unknown as Parameters<typeof startAgentWorker>[0]
  const ref = { current: () => "inst-1", renew: async () => "inst-1" } as unknown as InstanceRef
  const stop = startAgentWorker(component, ref, { handler })
  try {
    const submitted = await submittedP
    const text = new TextDecoder().decode(submitted.result)
    return { submitted, task: text ? JSON.parse(text) : {} }
  } finally {
    stop()
  }
}

const fakeRun = (seen: OpencodeRunOptions[], text = "found one issue") =>
  async (opts: OpencodeRunOptions): Promise<OpencodeRunResult> => {
    seen.push(opts)
    return { text, sessionId: "ses_1", finishReason: "stop", tokens: { total: 10, output: 4 }, cost: 0.5 } as OpencodeRunResult
  }

test("a finished run submits an A2A Task in the completed state", async () => {
  const seen: OpencodeRunOptions[] = []
  const { submitted, task } = await serve("scan the repo", (item) =>
    agentHandler(item, { workspace: "/srv/work", run: fakeRun(seen) }),
  )
  assert.equal(submitted.error, undefined)
  assert.equal(task.status?.state, "TASK_STATE_COMPLETED")
  assert.equal(task.id, "t-1")
  assert.equal(task.contextId, "c-1")
  assert.equal(seen[0]?.goal, "scan the repo")
  assert.equal(seen[0]?.env?.GIBSON_MISSION_RUN_ID, "run-1")
  assert.equal(seen[0]?.env?.GIBSON_AGENT_RUN_ID, "ar-1")
  assert.equal(seen[0]?.env?.GIBSON_CALLBACK_TOKEN, undefined, "the task grant stays in the SDK")
})

test("a work item with no goal submits an A2A Task in the failed state, not an exception", async () => {
  const seen: OpencodeRunOptions[] = []
  const { submitted, task } = await serve("   ", (item) =>
    agentHandler(item, { workspace: "/srv/work", run: fakeRun(seen) }),
  )
  assert.equal(submitted.error, undefined)
  assert.equal(task.status?.state, "TASK_STATE_FAILED")
  assert.equal(seen.length, 0, "opencode never ran")
})
