// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { createServer as createH2Server } from "node:http2"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Code, ConnectError, createClient } from "@connectrpc/connect"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { ComponentService, IDENTITY_SOCKET_ENV, SANDBOX_ID_HEADER, SANDBOX_IDENTITY_HEADER } from "@zeroroot-ai/sdk"
import { platformTransport } from "./platform-ca.js"

/**
 * The sandbox identity on the transport of the driver (zeroroot-ai/sdk#251).
 * Every platform client of the member goes through platformTransport, so each
 * call carries a new setec identity token from SETEC_IDENTITY_SOCKET.
 */

/** A fake setec identity socket. Each request gets a new token of the current generation. */
async function identitySocket(answer?: (res: ServerResponse) => void) {
  const dir = mkdtempSync(join(tmpdir(), "id"))
  const path = join(dir, "identity.sock")
  const state = { generation: 0, requests: 0 }
  const server = createServer((_req, res) => {
    state.requests++
    if (answer) return answer(res)
    res.end(JSON.stringify({ token: `gen${state.generation}-req${state.requests}` }))
  })
  await new Promise<void>((r) => server.listen(path, r))
  return {
    path,
    snapshot: () => void state.generation++,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The edge of the daemon over h2c. It records the identity headers of each heartbeat. */
async function edge() {
  const seen: { token: string | null; host: string | null }[] = []
  const server = createH2Server(
    connectNodeAdapter({
      routes: (router) =>
        router.service(ComponentService, {
          heartbeat: async (_req, ctx) => {
            seen.push({ token: ctx.requestHeader.get(SANDBOX_IDENTITY_HEADER), host: ctx.requestHeader.get(SANDBOX_ID_HEADER) })
            return { registered: true }
          },
        }),
    }),
  )
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { url: `http://127.0.0.1:${address.port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}

/** Run fn with SETEC_IDENTITY_SOCKET set to value, or unset for undefined. */
async function withSocketEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const old = process.env[IDENTITY_SOCKET_ENV]
  if (value === undefined) delete process.env[IDENTITY_SOCKET_ENV]
  else process.env[IDENTITY_SOCKET_ENV] = value
  try {
    await fn()
  } finally {
    if (old === undefined) delete process.env[IDENTITY_SOCKET_ENV]
    else process.env[IDENTITY_SOCKET_ENV] = old
  }
}

test("each platform call carries a new identity token and the hostname", async () => {
  const sock = await identitySocket()
  const daemon = await edge()
  try {
    await withSocketEnv(sock.path, async () => {
      const component = createClient(ComponentService, platformTransport(daemon.url, () => "grant", undefined))
      await component.heartbeat({ instanceId: "mem-1" })
      await component.heartbeat({ instanceId: "mem-1" })
    })
    assert.deepEqual(daemon.seen, [
      { token: "gen0-req1", host: hostname().trim() },
      { token: "gen0-req2", host: hostname().trim() },
    ])
  } finally {
    await daemon.close()
    await sock.close()
  }
})

test("a fork after a snapshot sends its own token, never a cached parent token", async () => {
  const sock = await identitySocket()
  const daemon = await edge()
  try {
    await withSocketEnv(sock.path, async () => {
      const component = createClient(ComponentService, platformTransport(daemon.url, () => "grant", undefined))
      await component.heartbeat({ instanceId: "mem-1" })
      sock.snapshot()
      await component.heartbeat({ instanceId: "mem-1" })
    })
    assert.deepEqual(daemon.seen.map((s) => s.token), ["gen0-req1", "gen1-req2"])
  } finally {
    await daemon.close()
    await sock.close()
  }
})

test("a missing token is a clear error, and no socket sends no token", async () => {
  const refusing = await identitySocket((res) => {
    res.statusCode = 502
    res.end(JSON.stringify({ error: "reach the launcher: no route" }))
  })
  const daemon = await edge()
  try {
    await withSocketEnv(refusing.path, async () => {
      const component = createClient(ComponentService, platformTransport(daemon.url, () => "grant", undefined))
      await assert.rejects(
        component.heartbeat({ instanceId: "mem-1" }),
        (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated && /reach the launcher: no route/.test(err.message),
      )
    })
    assert.equal(daemon.seen.length, 0, "a call with no token is not sent")

    await withSocketEnv(undefined, async () => {
      const component = createClient(ComponentService, platformTransport(daemon.url, () => "grant", undefined))
      await component.heartbeat({ instanceId: "mem-1" })
    })
    assert.equal(daemon.seen[0]?.token, null)
  } finally {
    await daemon.close()
    await refusing.close()
  }
})
