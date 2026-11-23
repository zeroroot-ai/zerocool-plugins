// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { connectorToolId, harnessToolCaller, ToolCallError, type ToolHarness } from "./connector-tools.js"

function fakeHarness(grant: string, respond: (req: { name: string; inputJson: Uint8Array }) => unknown) {
  const requests: { name: string; body: { id: string; args: unknown } }[] = []
  const state = { stopped: false }
  const harness = {
    context: { missionId: "m", taskId: "t", agentName: "a", missionRunId: "r", grant } as never,
    client: {
      callToolProto: async (req: { name: string; inputJson: Uint8Array }) => {
        requests.push({ name: req.name, body: JSON.parse(new TextDecoder().decode(req.inputJson)) })
        return respond(req)
      },
    },
    stop: () => {
      state.stopped = true
    },
  } as unknown as ToolHarness
  return { harness, requests, state }
}

const ok = (result: unknown) => () => ({ outputJson: new TextEncoder().encode(JSON.stringify({ result })), error: undefined })

test("the tool id is mcp:<connector>:<tool> from the slash form of the reference", () => {
  assert.equal(connectorToolId("connector/acme", "list_tree"), "mcp:acme:list_tree")
  assert.throws(() => connectorToolId("connector/a:b", "x"), /names no connector/)
})

test("a call goes through the invoke_tool meta-tool and returns the unwrapped result", async () => {
  const f = fakeHarness("g1", ok({ found: true }))
  const call = harnessToolCaller(() => f.harness)
  assert.deepEqual(await call("g1", "connector/acme", "read_file", { project: "acme/api", path: "a" }), { found: true })
  assert.deepEqual(f.requests, [{ name: "invoke_tool", body: { id: "mcp:acme:read_file", args: { project: "acme/api", path: "a" } } }])
})

test("a refusal of the daemon or the tool throws with the tool name and the daemon text", async () => {
  const f = fakeHarness("g1", () => ({ outputJson: new Uint8Array(), error: { message: "not authorized to invoke tool" } }))
  await assert.rejects(harnessToolCaller(() => f.harness)("g1", "connector/acme", "open_merge_request", {}), (e: Error) => e instanceof ToolCallError && /open_merge_request: not authorized to invoke tool/.test(e.message))
})

test("one harness serves one grant, and a new grant replaces and stops it", async () => {
  const opened: string[] = []
  const made: ReturnType<typeof fakeHarness>[] = []
  const call = harnessToolCaller((grant) => {
    opened.push(grant)
    const f = fakeHarness(grant, ok(grant))
    made.push(f)
    return f.harness
  })
  assert.equal(await call("g1", "connector/acme", "x", {}), "g1")
  assert.equal(await call("g1", "connector/acme", "x", {}), "g1")
  assert.deepEqual(opened, ["g1"])
  assert.equal(await call("g2", "connector/acme", "x", {}), "g2")
  assert.deepEqual(opened, ["g1", "g2"])
  assert.equal(made[0]!.state.stopped, true)
  assert.equal(made[1]!.state.stopped, false)
})
