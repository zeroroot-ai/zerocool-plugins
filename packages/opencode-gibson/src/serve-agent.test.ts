// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { EXTENSION_KEY, startAgentWorker, type InstanceRef } from "@zeroroot-ai/sdk"

import { agentHandler, NO_GATEWAY_PATH } from "./serve-agent.js"

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

type Task = { id?: string; contextId?: string; status?: { state?: string }; metadata?: Record<string, unknown> }

/** Serve one work item, and return what the worker submitted for it. */
async function serve(goal: string): Promise<{ submitted: Submitted; task: Task }> {
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
  const stop = startAgentWorker(component, ref, { handler: agentHandler })
  try {
    const submitted = await submittedP
    const text = new TextDecoder().decode(submitted.result)
    return { submitted, task: text ? JSON.parse(text) : {} }
  } finally {
    stop()
  }
}

test("a polled work item gets a failed A2A Task that says why, and no opencode child starts", async () => {
  // A child that would run opencode. It writes a marker file when it starts.
  const dir = await mkdtemp(join(tmpdir(), "zerocool-agent-"))
  const marker = join(dir, "started")
  const bin = join(dir, "opencode")
  await writeFile(bin, `#!/bin/sh\necho started > ${marker}\n`)
  await chmod(bin, 0o755)
  const saved = process.env.ZEROCOOL_OPENCODE_BIN
  process.env.ZEROCOOL_OPENCODE_BIN = bin
  try {
    const { submitted, task } = await serve("scan the repo")
    assert.equal(submitted.error, undefined, "a Task, not a work item error")
    assert.equal(task.status?.state, "TASK_STATE_FAILED")
    assert.equal(task.id, "t-1")
    assert.equal(task.contextId, "c-1")
    const ext = task.metadata?.[EXTENSION_KEY] as { error?: { code?: string; message?: string } } | undefined
    assert.equal(ext?.error?.code, NO_GATEWAY_PATH)
    assert.match(ext?.error?.message ?? "", /direct provider key is not a substitute/)
    await assert.rejects(() => readFile(marker), "no child ran, so no direct key and no component-grant knowledge read")
  } finally {
    if (saved === undefined) delete process.env.ZEROCOOL_OPENCODE_BIN
    else process.env.ZEROCOOL_OPENCODE_BIN = saved
  }
})
