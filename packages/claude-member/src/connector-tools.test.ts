// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { connectorToolId, harnessToolCaller, ToolCallError, type ToolHarness } from "./connector-tools.js"

function fakeHarness(grant: string, respond: (req: { name: string; inputJson: Uint8Array }) => unknown) {
  const requests: { name: string; body: { id: string; args: unknown } }[] = []
  const state = { stopped: false, token: grant }
  const harness = {
    context: { missionId: "m", taskId: "t", agentName: "a", missionRunId: "r", grant } as never,
    client: {
      callToolProto: async (req: { name: string; inputJson: Uint8Array }) => {
        requests.push({ name: req.name, body: JSON.parse(new TextDecoder().decode(req.inputJson)) })
        return respond(req)
      },
    },
    token: () => state.token,
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

test("one harness serves one grant, and the oldest is stopped when the cap is reached", async () => {
  const opened: string[] = []
  const made: ReturnType<typeof fakeHarness>[] = []
  const call = harnessToolCaller((grant) => {
    opened.push(grant)
    const f = fakeHarness(grant, ok(grant))
    made.push(f)
    return f.harness
  }, 1)
  assert.equal(await call("g1", "connector/acme", "x", {}), "g1")
  assert.equal(await call("g1", "connector/acme", "x", {}), "g1")
  assert.deepEqual(opened, ["g1"])
  assert.equal(await call("g2", "connector/acme", "x", {}), "g2")
  assert.deepEqual(opened, ["g1", "g2"])
  assert.equal(made[0]!.state.stopped, true)
  assert.equal(made[1]!.state.stopped, false)
})

test("current(grant) opens the harness once and returns the grant it holds now, after a renewal", () => {
  const made: ReturnType<typeof fakeHarness>[] = []
  const call = harnessToolCaller((grant) => {
    const f = fakeHarness(grant, ok(null))
    made.push(f)
    return f.harness
  })
  assert.equal(call.current("g1"), "g1")
  made[0]!.state.token = "g1-renewed"
  assert.equal(call.current("g1"), "g1-renewed", "the harness renews its grant, and current() reads it")
  assert.equal(made.length, 1, "one harness, one renewal timer")
})

const refuses = (error: { code?: number; message: string }) => fakeHarness("g", () => ({ outputJson: new Uint8Array(), error }))
const transientOf = async (h: ReturnType<typeof fakeHarness>): Promise<boolean> => {
  try {
    await harnessToolCaller(() => h.harness)("g", "connector/acme", "x", {})
  } catch (e) {
    if (e instanceof ToolCallError) return e.transient
  }
  throw new Error("the call did not throw a ToolCallError")
}

test("the code of the error decides: TIMEOUT, UNAVAILABLE and RESOURCE_EXHAUSTED are transient", async () => {
  for (const code of [4, 5, 8]) assert.equal(await transientOf(refuses({ code, message: "x" })), true, `code ${code}`)
  for (const code of [1, 2, 3, 6, 7]) assert.equal(await transientOf(refuses({ code, message: "x" })), false, `code ${code}`)
})

test("the code is the only classification: the text is never read", async () => {
  assert.equal(await transientOf(refuses({ code: 2, message: "bad input. Call the tool again." })), false, "INVALID_ARGUMENT is never retried, whatever the text says")
  assert.equal(await transientOf(refuses({ code: 5, message: "permission denied" })), true, "UNAVAILABLE is retried, whatever the text says")
  assert.equal(await transientOf(refuses({ code: 0, message: "the host is busy, call the tool again" })), false, "an unspecified code is permanent, even with a retry phrase")
  assert.equal(await transientOf(refuses({ message: "timed out. Call the tool again." })), false)
  assert.equal(await transientOf(refuses({ code: 0, message: "read /srv/unavailable/timeout.go: not found" })), false)
})

test("a thrown transport failure is classified by its gRPC code", async () => {
  const throws = (code: number) =>
    fakeHarness("g", () => {
      throw Object.assign(new Error("transport"), { code })
    })
  for (const code of [4, 8, 14]) assert.equal(await transientOf(throws(code)), true, `grpc ${code}`)
  for (const code of [3, 5, 7, 16]) assert.equal(await transientOf(throws(code)), false, `grpc ${code}`)
})

test("release(grant) stops the harness and its renewal, and a later call opens a new one", async () => {
  const made: ReturnType<typeof fakeHarness>[] = []
  const call = harnessToolCaller((grant) => {
    const f = fakeHarness(grant, ok(null))
    made.push(f)
    return f.harness
  })
  call.current("g1")
  call.current("g2")
  call.release("g1")
  assert.equal(made[0]!.state.stopped, true, "the renewal timer of the first grant is stopped")
  assert.equal(made[1]!.state.stopped, false, "another job's grant is not touched")
  call.release("unknown")
  call.current("g1")
  assert.equal(made.length, 3, "a grant used again opens a new harness")
})
