// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GIBSON_MCP_PACKAGE, gibsonMcpServer } from "./mcp-config.js"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { httpProbeHandler, probe } from "./http-probe.js"

// ---------------------------------------------------------------------------
// A7: the plugin is an adapter. The tools come from the Gibson MCP server.
// ---------------------------------------------------------------------------

test("the mcp entry spawns the published server over stdio, and carries no credential", () => {
  const server = gibsonMcpServer({ GIBSON_PLATFORM_URL: "https://api.example", GIBSON_CG_JWT: "grant", GIBSON_BOOTSTRAP_TOKEN: "one-time" })
  assert.equal(server.type, "local")
  assert.equal(server.enabled, true)
  assert.deepEqual(server.command.slice(0, 2), ["npx", "--yes"])
  assert.ok(server.command.includes(GIBSON_MCP_PACKAGE))
  assert.deepEqual(server.command.slice(-2), ["--transport", "stdio"])
  assert.deepEqual(server.environment, { GIBSON_PLATFORM_URL: "https://api.example" }, "addressing only: the server checks in on its own")
})

test("the mcp entry omits an empty environment rather than writing an empty object", () => {
  assert.equal(gibsonMcpServer({}).environment, undefined)
})

test("the plugin registers no tools of its own, in any posture", async () => {
  const saved = { url: process.env.GIBSON_PLATFORM_URL, tok: process.env.GIBSON_BOOTSTRAP_TOKEN }
  delete process.env.GIBSON_PLATFORM_URL
  delete process.env.GIBSON_BOOTSTRAP_TOKEN
  try {
    const { GibsonPlugin } = await import("./index.js")
    const hooks = await GibsonPlugin({} as never, {})
    assert.equal(hooks.tool, undefined, "every tool comes from the MCP server (ADR-0008)")
  } finally {
    if (saved.url) process.env.GIBSON_PLATFORM_URL = saved.url
    if (saved.tok) process.env.GIBSON_BOOTSTRAP_TOKEN = saved.tok
  }
})

test("standalone still registers the MCP server, so the agent keeps its Gibson tools", async () => {
  const saved = { url: process.env.GIBSON_PLATFORM_URL, tok: process.env.GIBSON_BOOTSTRAP_TOKEN }
  delete process.env.GIBSON_PLATFORM_URL
  delete process.env.GIBSON_BOOTSTRAP_TOKEN
  try {
    const { GibsonPlugin } = await import("./index.js")
    const hooks = await GibsonPlugin({} as never, {})
    const config: { mcp?: Record<string, { command: string[] }>; provider?: Record<string, unknown> } = {}
    await hooks.config?.(config as never)
    assert.ok(config.mcp?.gibson, "the server runs and reports its own posture")
    assert.equal(config.provider?.gibson, undefined, "no provider without a platform: there is no harness to route to")
  } finally {
    if (saved.url) process.env.GIBSON_PLATFORM_URL = saved.url
    if (saved.tok) process.env.GIBSON_BOOTSTRAP_TOKEN = saved.tok
  }
})

test("a platform URL with no token and no host key stays standalone and explains why", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-"))
  const saved = {
    url: process.env.GIBSON_PLATFORM_URL,
    tok: process.env.GIBSON_BOOTSTRAP_TOKEN,
    key: process.env.GIBSON_HOST_KEY_PATH,
  }
  const errors: string[] = []
  const originalError = console.error
  console.error = (msg: unknown) => errors.push(String(msg))

  process.env.GIBSON_PLATFORM_URL = "https://api.example.test"
  process.env.GIBSON_HOST_KEY_PATH = join(dir, "absent.key")
  delete process.env.GIBSON_BOOTSTRAP_TOKEN
  try {
    const { GibsonPlugin } = await import("./index.js")
    const hooks = await GibsonPlugin({} as never, {})
    assert.equal(hooks.tool, undefined)
    // The operator must be told how to enrol, not left guessing.
    assert.ok(errors.some((e) => e.includes("gibson agent enroll")), "should name the enroll command")
  } finally {
    console.error = originalError
    if (saved.url) process.env.GIBSON_PLATFORM_URL = saved.url
    else delete process.env.GIBSON_PLATFORM_URL
    if (saved.tok) process.env.GIBSON_BOOTSTRAP_TOKEN = saved.tok
    if (saved.key) process.env.GIBSON_HOST_KEY_PATH = saved.key
    else delete process.env.GIBSON_HOST_KEY_PATH
  }
})

// ---------------------------------------------------------------------------
// http_probe — the tool zerocool serves to the fleet (zerocool-plugins#14).
// ---------------------------------------------------------------------------

test("httpProbeHandler refuses an invocation with no url", async () => {
  await assert.rejects(
    () => httpProbeHandler({ workId: "w1", workType: "execute_proto", context: {}, input: {} }),
    /requires a `url`/,
    "a probe that silently picks its own target is worse than a failed node",
  )
})

test("httpProbeHandler refuses a non-http scheme", async () => {
  await assert.rejects(
    () =>
      httpProbeHandler({
        workId: "w2",
        workType: "execute_proto",
        context: {},
        input: { url: "file:///etc/passwd" },
      }),
    /unsupported scheme/,
    "file:// would turn a mission node into a local file read",
  )
})

test("probe reports the response facts without echoing the body", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", server: "test-origin" })
    res.end("hello from the origin")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  try {
    const result = await probe(`http://127.0.0.1:${port}/`)
    assert.equal(result.status, 200)
    assert.equal(result.server, "test-origin")
    assert.equal(result.bytes, Buffer.byteLength("hello from the origin"))
    assert.ok(!JSON.stringify(result).includes("hello from the origin"),
      "the body must be measured, not returned — it is untrusted remote content")
  } finally {
    server.close()
  }
})
