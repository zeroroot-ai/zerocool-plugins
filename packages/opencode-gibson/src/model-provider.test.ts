// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { RESPONSES_PATH, type ResolvedModel } from "@zeroroot-ai/sdk"

import { gatewayProvider, resolveProvider } from "./model-provider.js"

/** What the fake gateway saw. */
interface Seen {
  method?: string
  url?: string
  headers: IncomingHttpHeaders
  body: string
}

type ProviderOptions = { baseURL: string; apiKey: string; fetch: typeof fetch }
type ProviderModels = Record<string, { id: string; limit?: { context: number; output: number } }>

const reply = (gatewayUrl: string, extra: Partial<ResolvedModel> = {}): ResolvedModel => ({
  model: "claude-sonnet-x",
  provider: "tenant-provider",
  gatewayUrl,
  routeHeaders: { "x-route-model": "claude-sonnet-x", "x-route-tenant": "t1" },
  contextWindow: 200000,
  maxOutputTokens: 8192,
  gatewayCaPem: "",
  ...extra,
})

const responseBody = JSON.stringify({ id: "resp_1", status: "completed", output: [] })

/** Send the call that the AI SDK makes for an Open Responses turn. */
async function turn(provider: Record<string, unknown>): Promise<Response> {
  const options = provider.options as ProviderOptions
  return await options.fetch(`${options.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({ model: "claude-sonnet-x", input: [] }),
  })
}

async function withHttpGateway(fn: (url: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = []
  const server = createHttpServer((req, res) => {
    let body = ""
    req.on("data", (d: Buffer) => (body += d.toString()))
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(200, { "content-type": "application/json" }).end(responseBody)
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test("a turn calls POST {gatewayUrl}/v1/responses with the grant and the route headers of the reply", async () => {
  await withHttpGateway(async (url, seen) => {
    const provider = gatewayProvider(reply(url), "primary", () => "grant-1")
    const res = await turn(provider)
    assert.equal(res.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.method, "POST")
    assert.equal(seen[0]?.url, RESPONSES_PATH)
    assert.equal(seen[0]?.headers["x-capability-grant"], "grant-1")
    assert.equal(seen[0]?.headers["x-route-model"], "claude-sonnet-x")
    assert.equal(seen[0]?.headers["x-route-tenant"], "t1")
    assert.equal(seen[0]?.headers.authorization, undefined, "the placeholder key never leaves the process")
    assert.equal(JSON.parse(seen[0]?.body ?? "{}").model, "claude-sonnet-x")
  })
})

test("the plugin resolves the slot with resolveModel and sends the grant of the harness", async () => {
  await withHttpGateway(async (url, seen) => {
    const slots: string[] = []
    let grant = "task-grant-1"
    const provider = await resolveProvider(
      {
        resolveModel: async (slot) => {
          slots.push(slot)
          return reply(url)
        },
        token: () => grant,
      },
      "primary",
    )
    assert.deepEqual(slots, ["primary"], "one call to the daemon, then the provider is fixed")
    await turn(provider)
    grant = "task-grant-2"
    await turn(provider)
    assert.deepEqual(
      seen.map((s) => s.headers["x-capability-grant"]),
      ["task-grant-1", "task-grant-2"],
    )
    assert.equal(seen[0]?.headers["x-route-tenant"], "t1")
    assert.deepEqual(slots, ["primary"], "a turn does not call the daemon again")
  })
})

test("a refused slot is an error, not a provider", async () => {
  await assert.rejects(
    () =>
      resolveProvider(
        {
          resolveModel: async () => {
            throw new Error("slot primary is not bound")
          },
          token: () => "g",
        },
        "primary",
      ),
    /not bound/,
  )
})

test("a trailing slash on the gateway URL does not change the route", async () => {
  await withHttpGateway(async (url, seen) => {
    await turn(gatewayProvider(reply(`${url}/`), "primary", () => "g"))
    assert.equal(seen[0]?.url, RESPONSES_PATH)
  })
})

test("each turn sends the current grant, so a renewal reaches the gateway", async () => {
  await withHttpGateway(async (url, seen) => {
    let grant = "grant-1"
    const provider = gatewayProvider(reply(url), "primary", () => grant)
    await turn(provider)
    grant = "grant-2"
    await turn(provider)
    assert.deepEqual(
      seen.map((s) => s.headers["x-capability-grant"]),
      ["grant-1", "grant-2"],
    )
  })
})

test("the provider names the slot, the exact model of the reply and its limits", () => {
  const provider = gatewayProvider(reply("https://gw.example"), "primary", () => "g")
  assert.equal(provider.npm, "@ai-sdk/openai")
  assert.equal((provider.options as ProviderOptions).baseURL, "https://gw.example/v1")
  const models = provider.models as ProviderModels
  assert.equal(models.primary?.id, "claude-sonnet-x")
  assert.deepEqual(models.primary?.limit, { context: 200000, output: 8192 })
  const unknown = gatewayProvider(reply("https://gw.example", { contextWindow: 0, maxOutputTokens: 0 }), "primary", () => "g")
  assert.equal((unknown.models as ProviderModels).primary?.limit, undefined, "0 means unknown, so no limit is set")
})

test("a CA bundle with an http URL is refused before any call", () => {
  const ca = makeCa("only-ca").pem
  assert.throws(() => gatewayProvider(reply("http://gw.example", { gatewayCaPem: ca }), "primary", () => "g"), /https/)
})

// ---------------------------------------------------------------------------
// The CA rule, against a TLS server with a private CA.
// ---------------------------------------------------------------------------

interface Ca {
  pem: string
  sign: () => { key: string; cert: string }
}

/** Make a private CA, and a way to sign a localhost server certificate with it. */
function makeCa(name: string): Ca {
  const dir = mkdtempSync(join(tmpdir(), "zerocool-ca-"))
  const run = (...args: string[]): void => void execFileSync("openssl", args, { cwd: dir, stdio: "ignore" })
  try {
    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", `/CN=${name}`)
    const pem = readFileSync(join(dir, "ca.pem"), "utf8")
    return {
      pem,
      sign: () => {
        writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n")
        run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost")
        run("x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "2", "-extfile", "ext.cnf")
        return { key: readFileSync(join(dir, "srv.key"), "utf8"), cert: readFileSync(join(dir, "srv.pem"), "utf8") }
      },
    }
  } finally {
    // The material is read into memory above, and sign() runs before cleanup.
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }))
  }
}

async function withTlsGateway(signer: Ca, fn: (url: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = []
  const server = createHttpsServer(signer.sign(), (req, res) => {
    let body = ""
    req.on("data", (d: Buffer) => (body += d.toString()))
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(200, { "content-type": "application/json" }).end(responseBody)
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  try {
    await fn(`https://localhost:${(server.address() as AddressInfo).port}`, seen)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test("the plugin trusts the CA bundle of the reply for the gateway", async () => {
  const ca = makeCa("gateway-ca")
  await withTlsGateway(ca, async (url, seen) => {
    const res = await turn(gatewayProvider(reply(url, { gatewayCaPem: ca.pem }), "primary", () => "g"))
    assert.equal(res.status, 200)
    assert.equal(seen[0]?.headers["x-capability-grant"], "g")
  })
})

test("the plugin trusts only the CA bundle of the reply", async () => {
  const gatewayCa = makeCa("gateway-ca")
  const otherCa = makeCa("other-ca")
  await withTlsGateway(gatewayCa, async (url, seen) => {
    // The bundle names another CA, so the certificate of this gateway fails.
    await assert.rejects(() => turn(gatewayProvider(reply(url, { gatewayCaPem: otherCa.pem }), "primary", () => "g")))
    assert.equal(seen.length, 0, "no request, and so no grant, reached a server the bundle does not vouch for")
  })
})

test("with no bundle in the reply the plugin uses the system roots, so a private CA fails", async () => {
  const ca = makeCa("gateway-ca")
  await withTlsGateway(ca, async (url, seen) => {
    await assert.rejects(() => turn(gatewayProvider(reply(url), "primary", () => "g")))
    assert.equal(seen.length, 0)
  })
})
