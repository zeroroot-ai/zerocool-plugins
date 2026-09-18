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

import { HTTP_PROBE_TIMEOUT_MS, httpProbeHandler, isInternalAddress, probe } from "./http-probe.js"

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
    // The origin under test is local, so the name is resolved to a public
    // address by the injected lookup and the transport is pointed at the
    // local listener. The address check runs for real on the lookup result.
    const publicName = "origin.example"
    const result = await probe(`http://${publicName}:${port}/`, HTTP_PROBE_TIMEOUT_MS, {
      lookup: async (host) => (host === publicName ? [{ address: "93.184.216.34", family: 4 }] : []),
      fetch: (input, init) => fetch(String(input).replace(publicName, "127.0.0.1"), init),
    })
    assert.equal(result.status, 200)
    assert.equal(result.server, "test-origin")
    assert.equal(result.bytes, Buffer.byteLength("hello from the origin"))
    assert.ok(!JSON.stringify(result).includes("hello from the origin"),
      "the body must be measured, not returned — it is untrusted remote content")
  } finally {
    server.close()
  }
})

test("probe refuses loopback, link-local, private and unique-local targets before any connection", async () => {
  let fetched = 0
  const deps = { fetch: (async () => (fetched++, new Response(""))) as unknown as typeof globalThis.fetch }
  const refused = [
    "http://127.0.0.1/",
    "http://127.8.8.8/",
    "http://0.0.0.0/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://224.0.0.1/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[fc00::1]/",
    "http://[ff02::1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:127.0.0.1]/",
  ]
  for (const url of refused) {
    await assert.rejects(probe(url, HTTP_PROBE_TIMEOUT_MS, deps), /not a public address/, url)
  }
  assert.equal(fetched, 0, "a refused target is never connected to")
})

test("probe resolves a name and refuses it when any address is internal", async () => {
  let fetched = 0
  const deps = {
    lookup: async (host: string) => {
      if (host === "localhost") return [{ address: "127.0.0.1", family: 4 }]
      if (host === "kubernetes.default.svc") return [{ address: "10.96.0.1", family: 4 }]
      if (host === "rebind.example") return [{ address: "93.184.216.34", family: 4 }, { address: "192.168.0.10", family: 4 }]
      if (host === "nowhere.example") return []
      return [{ address: "93.184.216.34", family: 4 }]
    },
    fetch: (async () => (fetched++, new Response(null, { status: 204 }))) as unknown as typeof globalThis.fetch,
  }
  await assert.rejects(probe("http://localhost:8080/", HTTP_PROBE_TIMEOUT_MS, deps), /resolves to 127\.0\.0\.1/)
  await assert.rejects(probe("https://kubernetes.default.svc/", HTTP_PROBE_TIMEOUT_MS, deps), /resolves to 10\.96\.0\.1/)
  await assert.rejects(probe("http://rebind.example/", HTTP_PROBE_TIMEOUT_MS, deps), /192\.168\.0\.10/, "one internal address among public ones refuses the host")
  await assert.rejects(probe("http://nowhere.example/", HTTP_PROBE_TIMEOUT_MS, deps), /resolves to no address/)
  assert.equal(fetched, 0)
  const ok = await probe("https://public.example/", HTTP_PROBE_TIMEOUT_MS, deps)
  assert.equal(ok.status, 204)
  assert.equal(fetched, 1)
})

test("probe reports a redirect and never follows it", async () => {
  let calls = 0
  const deps = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: (async (_input: unknown, init: RequestInit) => {
      calls++
      assert.equal(init.redirect, "manual")
      return new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } })
    }) as unknown as typeof globalThis.fetch,
  }
  const r = await probe("https://public.example/", HTTP_PROBE_TIMEOUT_MS, deps)
  assert.equal(r.status, 302)
  assert.equal(calls, 1, "the location header is reported through the status, not fetched")
})

test("the address classifier names every refused range", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.5.5", "172.31.0.1", "192.168.0.1", "169.254.169.254", "100.64.1.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "0:0:0:0:0:0:0:1", "fe80::1", "fe80::1%eth0", "fc00::1", "fdff::1", "ff02::1", "::ffff:192.168.1.1", "::ffff:c0a8:101", "::ffff:7f00:1", "::10.0.0.1", "not-an-ip"]) {
    assert.equal(isInternalAddress(a), true, a)
  }
  for (const a of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:2800:220:1:248:1893:25c8:1946", "2001:db8::1", "::ffff:8.8.8.8", "::ffff:808:808"]) {
    assert.equal(isInternalAddress(a), false, a)
  }
})
