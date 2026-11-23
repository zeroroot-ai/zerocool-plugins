// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { startWorkspaceMcp } from "./workspace-mcp.js"

async function rpc(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : undefined }
}

test("the endpoint speaks MCP: initialize, list the one tool, and call it", async () => {
  const mcp = await startWorkspaceMcp()
  const seen: [string | undefined, string][] = []
  const turn = mcp.register(async (repository, path) => {
    seen.push([repository, path])
    return path === "bad" ? { ok: false, text: "the file is not text" } : { ok: true, text: `${path} is in the worktree.` }
  })
  try {
    const init = await rpc(turn.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    assert.equal(init.json.result.protocolVersion, "2025-06-18")
    assert.deepEqual(init.json.result.capabilities, { tools: {} })
    assert.equal((await rpc(turn.url, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202)
    const list = await rpc(turn.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    assert.deepEqual(list.json.result.tools.map((t: { name: string }) => t.name), ["fetch_file"])
    const ok = await rpc(turn.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fetch_file", arguments: { path: "a.txt", repository: "api" } } })
    assert.deepEqual(ok.json.result, { isError: false, content: [{ type: "text", text: "a.txt is in the worktree." }] })
    const bad = await rpc(turn.url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fetch_file", arguments: { path: "bad" } } })
    assert.equal(bad.json.result.isError, true)
    assert.match(bad.json.result.content[0].text, /not text/)
    assert.deepEqual(seen, [["api", "a.txt"], [undefined, "bad"]])
    assert.equal((await rpc(turn.url, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "other", arguments: {} } })).json.error.code, -32602)
    assert.equal((await rpc(turn.url, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "fetch_file", arguments: {} } })).json.result.isError, true)
  } finally {
    turn.dispose()
    await mcp.stop()
  }
})

test("each turn has its own path, and a disposed or unknown path answers 404", async () => {
  const mcp = await startWorkspaceMcp()
  const a = mcp.register(async () => ({ ok: true, text: "a" }))
  const b = mcp.register(async () => ({ ok: true, text: "b" }))
  try {
    assert.notEqual(a.url, b.url)
    const call = (url: string) => rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch_file", arguments: { path: "x" } } })
    assert.equal((await call(a.url)).json.result.content[0].text, "a")
    assert.equal((await call(b.url)).json.result.content[0].text, "b")
    a.dispose()
    assert.equal((await call(a.url)).status, 404)
    assert.equal((await call(a.url.replace(/\/t\/[^/]+\//, "/t/AAAAAAAAAAAAAAAAAAAAAAAA/"))).status, 404)
    const get = await fetch(b.url)
    assert.equal(get.status, 405)
  } finally {
    b.dispose()
    await mcp.stop()
  }
})
