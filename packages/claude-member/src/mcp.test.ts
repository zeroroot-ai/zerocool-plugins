// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { assertTurnRequiresToken, freePort, mcpGateway, McpError, mintTurnToken, startMcpServer, TURN_TOKEN_ENV, type TurnBody } from "./mcp.js"

const FAKE = fileURLToPath(new URL("../test/bin/fake-gibson-mcp.mjs", import.meta.url))

const TOKEN = "test-turn-token"

/** A stand-in for the server's HTTP surface, recording what the driver sent. */
async function turnServer(): Promise<{ base: string; calls: { method: string; authorization: string; body?: TurnBody }[]; close: () => Promise<void> }> {
  const calls: { method: string; authorization: string; body?: TurnBody }[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      calls.push({ method: req.method ?? "", authorization: req.headers.authorization ?? "", ...(raw ? { body: JSON.parse(raw) as TurnBody } : {}) })
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
  assert.equal(mcpGateway("http://127.0.0.1:7788", { token: TOKEN }).url, "http://127.0.0.1:7788/mcp")
  assert.equal(mcpGateway("http://127.0.0.1:7788/", { token: TOKEN }).url, "http://127.0.0.1:7788/mcp")
})

test("a turn puts the job's own grant in force, with the callback endpoint, under the bearer token", async () => {
  const s = await turnServer()
  try {
    const gateway = mcpGateway(s.base, { token: TOKEN, callbackEndpoint: "gibson:50001", insecure: true })
    await gateway.useGrant("job-1", "turn-grant-of-this-dispatch")
    assert.equal(s.calls[0]!.method, "POST")
    assert.equal(s.calls[0]!.authorization, `Bearer ${TOKEN}`)
    assert.deepEqual(s.calls[0]!.body, { job_id: "job-1", grant: "turn-grant-of-this-dispatch", callback_endpoint: "gibson:50001", insecure: true })
  } finally {
    await s.close()
  }
})

test("releasing a turn deletes it under the same token, so later calls fall back to the base grant", async () => {
  const s = await turnServer()
  try {
    const gateway = mcpGateway(s.base, { token: TOKEN })
    await gateway.release("job-1")
    assert.equal(s.calls[0]!.method, "DELETE")
    assert.equal(s.calls[0]!.authorization, `Bearer ${TOKEN}`)
  } finally {
    await s.close()
  }
})

test("a gateway with no token is refused: the control plane is never called unauthenticated", () => {
  assert.throws(() => mcpGateway("http://127.0.0.1:1", { token: "" }), /no turn token/)
})

test("each process mints its own random token", () => {
  const a = mintTurnToken()
  const b = mintTurnToken()
  assert.ok(a.length >= 32 && b.length >= 32)
  assert.notEqual(a, b)
})

test("a refused turn raises, and the message never carries the grant", async () => {
  const gateway = mcpGateway("http://127.0.0.1:1", {
    token: TOKEN,
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
  const gateway = mcpGateway("http://127.0.0.1:1", { token: TOKEN, fetch: async () => new Response("no", { status: 500 }), log: (l) => logged.push(l) })
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

test("an unauthenticated POST /turn to the started server is rejected, and so is a wrong token", async () => {
  const server = await startMcpServer({
    bin: FAKE,
    callbackEndpoint: "gibson:50001",
    insecure: false,
    env: { ...process.env, FAKE_MCP_READY_AFTER_MS: "0" },
    cwd: process.cwd(),
    readyTimeoutMs: 10_000,
  })
  try {
    const body = JSON.stringify({ job_id: "job-x", grant: "stolen-grant" })
    const open = await fetch(`${server.base}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body })
    assert.equal(open.status, 401, "no token, no turn")
    const wrong = await fetch(`${server.base}/turn`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer guess" }, body })
    assert.equal(wrong.status, 401, "a guessed token is no token")
    const drop = await fetch(`${server.base}/turn`, { method: "DELETE" })
    assert.equal(drop.status, 401, "the child cannot drop a grant either")
    const seen = (await (await fetch(`${server.base}/turn`)).json()) as { job_id: string | null }
    assert.equal(seen.job_id, null, "nothing was put in force")
    await server.useGrant("job-1", "turn-grant")
    const now = (await (await fetch(`${server.base}/turn`)).json()) as { job_id: string | null }
    assert.equal(now.job_id, "job-1", "the driver's own token works")
  } finally {
    await server.stop()
  }
})

test("a server that accepts an unauthenticated POST /turn is refused at start", async () => {
  await assert.rejects(
    startMcpServer({
      bin: FAKE,
      callbackEndpoint: "gibson:50001",
      insecure: false,
      env: { ...process.env, FAKE_MCP_OPEN_TURN: "1" },
      cwd: process.cwd(),
      readyTimeoutMs: 10_000,
    }),
    (e: Error) => {
      assert.ok(e instanceof McpError)
      assert.match(e.message, /answered 200 to an unauthenticated POST \/turn, expected 401/)
      return true
    },
  )
})

test("the probe passes only on a 401", async () => {
  await assertTurnRequiresToken("http://127.0.0.1:1", async () => new Response("no", { status: 401 }))
  await assert.rejects(assertTurnRequiresToken("http://127.0.0.1:1", async () => new Response("{}", { status: 200 })), /expected 401/)
  await assert.rejects(assertTurnRequiresToken("http://127.0.0.1:1", async () => new Response("no", { status: 403 })), /expected 401/)
  assert.equal(TURN_TOKEN_ENV, "GIBSON_TURN_TOKEN", "a GIBSON_ name, which the Claude child never receives")
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
