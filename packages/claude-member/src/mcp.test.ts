// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { freePort, mcpGateway, McpError, startMcpServer, type TurnBody } from "./mcp.js"

const FAKE = fileURLToPath(new URL("../test/bin/fake-gibson-mcp.mjs", import.meta.url))

/** A stand-in for the server's HTTP surface, recording what the driver sent. */
async function turnServer(): Promise<{ base: string; calls: { method: string; body?: TurnBody }[]; close: () => Promise<void> }> {
  const calls: { method: string; body?: TurnBody }[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      calls.push({ method: req.method ?? "", ...(raw ? { body: JSON.parse(raw) as TurnBody } : {}) })
      if (req.url === "/turn") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ job_id: (calls.at(-1)?.body as TurnBody | undefined)?.job_id ?? null, endpoint: "gibson:50001" }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  const port = await freePort()
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()))
  return { base: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) }
}

test("freePort gives a usable loopback port", async () => {
  const port = await freePort()
  assert.ok(port > 1024 && port <= 65535)
})

test("the gateway's url is the MCP path Claude Code attaches to", () => {
  assert.equal(mcpGateway("http://127.0.0.1:7788", {}).url, "http://127.0.0.1:7788/mcp")
  assert.equal(mcpGateway("http://127.0.0.1:7788/", {}).url, "http://127.0.0.1:7788/mcp")
})

test("a turn puts the job's own grant in force, with the callback endpoint", async () => {
  const s = await turnServer()
  try {
    const gateway = mcpGateway(s.base, { callbackEndpoint: "gibson:50001", insecure: true })
    await gateway.useGrant("job-1", "turn-grant-of-this-dispatch")
    assert.equal(s.calls[0]!.method, "POST")
    assert.deepEqual(s.calls[0]!.body, { job_id: "job-1", grant: "turn-grant-of-this-dispatch", callback_endpoint: "gibson:50001", insecure: true })
  } finally {
    await s.close()
  }
})

test("releasing a turn deletes it, so later calls fall back to the base grant", async () => {
  const s = await turnServer()
  try {
    const gateway = mcpGateway(s.base, {})
    await gateway.release("job-1")
    assert.equal(s.calls[0]!.method, "DELETE")
  } finally {
    await s.close()
  }
})

test("a refused turn raises, and the message never carries the grant", async () => {
  const gateway = mcpGateway("http://127.0.0.1:1", {
    fetch: async () => new Response("no", { status: 403 }),
  })
  await assert.rejects(gateway.useGrant("job-1", "secret-grant"), (e: Error) => {
    assert.ok(e instanceof McpError)
    assert.match(e.message, /POST \/turn for job job-1 answered 403/)
    assert.ok(!e.message.includes("secret-grant"), "the console shows this line")
    return true
  })
})

test("a failed release is logged, not raised: the turn is already over", async () => {
  const logged: string[] = []
  const gateway = mcpGateway("http://127.0.0.1:1", { fetch: async () => new Response("no", { status: 500 }), log: (l) => logged.push(l) })
  await gateway.release("job-1")
  assert.match(logged[0]!, /DELETE \/turn after job job-1 answered 500/)
})

test("the server starts on a loopback port and is ready when it answers healthz", async () => {
  const server = await startMcpServer({
    bin: FAKE,
    callbackEndpoint: "gibson:50001",
    insecure: false,
    env: { ...process.env, FAKE_MCP_READY_AFTER_MS: "0" },
    cwd: process.cwd(),
    readyTimeoutMs: 10_000,
  })
  try {
    assert.match(server.base, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(server.url, `${server.base}/mcp`)
    assert.ok(server.pid && server.pid > 0)
    await server.useGrant("job-1", "turn-grant")
    const seen = (await (await fetch(`${server.base}/turn`)).json()) as { job_id: string | null }
    assert.equal(seen.job_id, "job-1", "the turn stayed in force")
    await server.release("job-1")
  } finally {
    await server.stop()
  }
})

test("a server that exits before it is ready fails with what it printed", async () => {
  await assert.rejects(
    startMcpServer({ bin: FAKE, callbackEndpoint: "gibson:50001", insecure: false, env: { ...process.env, FAKE_MCP_EXIT: "3" }, cwd: process.cwd(), readyTimeoutMs: 5000 }),
    /exited 3 before it was ready: no grant/,
  )
})

test("a server that never answers healthz fails on the deadline rather than hanging", async () => {
  await assert.rejects(
    startMcpServer({
      bin: FAKE,
      callbackEndpoint: "gibson:50001",
      insecure: false,
      env: { ...process.env, FAKE_MCP_READY_AFTER_MS: "60000" },
      cwd: process.cwd(),
      readyTimeoutMs: 400,
      sleep: async () => {},
    }),
    /did not answer .*\/healthz within 400ms/,
  )
})
