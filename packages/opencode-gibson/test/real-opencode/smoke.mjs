#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// The real opencode binary, the real plugin and the real driver, end to end.
//
// It proves what no fake binary can: with only the environment that the driver
// gives a granted child, opencode loads the zerocool plugin, the plugin opens
// the task harness on the callback endpoint, and the `gibson` provider sends
// its call to the Model gateway with the route headers of the reply and the
// task grant. The callback service and the gateway are fakes on localhost.
//
// Run it after `pnpm --filter @zeroroot-ai/zerocool build` and
// `tsc -p tsconfig.test.json` (it reads the TLS helpers from dist-test), with
// ZEROCOOL_OPENCODE_BIN naming the opencode binary of the image pin. The
// workflow .github/workflows/opencode-smoke.yml does exactly this. It is not
// part of `pnpm test`, because that suite must not need a binary or a network.
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { createServer } from "node:http2"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runOpencodeTask } from "../../dist/dispatch.js"
import { makeCa, withTlsGateway } from "../../dist-test/tls-fixture.test.js"

const GRANT_TAG = "real-opencode-smoke"
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const grant = `${b64({ alg: "EdDSA" })}.${b64({
  sub: "component:agent:zerocool",
  tenant: "t1",
  mission_id: "m-1",
  task_id: "t-1",
  mrid: "run-1",
  exp: 4_000_000_000,
  tag: GRANT_TAG,
})}.sig`

// Protobuf, by hand: a string field and a map<string,string> entry.
const varint = (n) => {
  const out = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}
const str = (field, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes])
}
const resolveModelReply = (gatewayUrl, caPem) =>
  Buffer.concat([
    str(1, "smoke-model"),
    str(2, "smoke-provider"),
    str(3, gatewayUrl),
    str(4, Buffer.concat([str(1, "x-route-tenant"), str(2, "t1")])),
    str(7, caPem),
  ])
const grpcFrame = (message) => {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(message.length, 1)
  return Buffer.concat([head, message])
}

/** A fake HarnessCallbackService on h2c. ResolveModel answers. Every other RPC is UNIMPLEMENTED. */
async function withCallbackServer(reply, fn) {
  const calls = []
  const server = createServer()
  server.on("stream", (stream, headers) => {
    calls.push({ path: headers[":path"], grant: headers["x-capability-grant"] })
    stream.resume()
    stream.on("end", () => {
      if (headers[":path"] === "/gibson.harness.v1.HarnessCallbackService/ResolveModel") {
        stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true })
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }))
        stream.end(grpcFrame(reply))
      } else {
        stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "12" }, { endStream: true })
      }
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  try {
    await fn(`127.0.0.1:${server.address().port}`, calls)
  } finally {
    server.close()
  }
}

const ca = makeCa("smoke-gateway-ca")
const workspace = await mkdtemp(join(tmpdir(), "zerocool-smoke-"))
process.env.OPENCODE_DISABLE_AUTOUPDATE = "1"
process.env.OPENCODE_DISABLE_MODELS_FETCH = "1"

await withTlsGateway(ca, async (gatewayUrl, seen) => {
  await withCallbackServer(resolveModelReply(gatewayUrl, ca.pem), async (endpoint, calls) => {
    let outcome
    try {
      outcome = await runOpencodeTask({
        goal: "Say hello.",
        workspace,
        // The fake gateway gives no answer opencode accepts, so opencode retries until
        // this deadline. The proof is in the first request, and the run ends with SIGTERM.
        timeoutMs: 45_000,
        grant: { callbackEndpoint: endpoint, callbackToken: grant, insecure: true, missionRunId: "run-1" },
      })
    } catch (e) {
      // The fake gateway gives no real answer, so the run may fail. The proof is what it sent.
      console.log(`run ended with an error, as expected: ${String(e.message).slice(0, 200)}`)
    }
    console.log(`outcome: ${JSON.stringify(outcome ?? null)}`)
    const count = (items) => Object.entries(items.reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {})).map(([k, n]) => `${k} x${n}`)
    console.log(`callback calls: ${JSON.stringify(count(calls.map((c) => c.path)))}`)
    console.log(`gateway requests: ${JSON.stringify(count(seen.map((s) => `${s.url} route=${s.headers["x-route-tenant"]} grant=${s.headers["x-capability-grant"] === grant} authorization=${s.headers.authorization}`)))}`)

    assert.ok(
      calls.some((c) => c.path === "/gibson.harness.v1.HarnessCallbackService/ResolveModel"),
      "the plugin loaded and resolved the slot through the task harness",
    )
    assert.ok(
      calls.every((c) => c.grant === grant),
      "each callback carried the task grant",
    )
    const call = seen.find((s) => s.url === "/v1/responses")
    assert.ok(call, "the gibson provider reached the gateway on /v1/responses")
    assert.equal(call.headers["x-capability-grant"], grant, "the call carries the task grant")
    assert.equal(call.headers["x-route-tenant"], "t1", "the call carries the route headers of the reply")
    assert.equal(call.headers.authorization, undefined, "the placeholder key is removed")
    assert.equal(JSON.parse(call.body).model, "smoke-model", "the call names the model of the reply")
    console.log("real opencode smoke: PASS")
  })
})
process.exit(0)
