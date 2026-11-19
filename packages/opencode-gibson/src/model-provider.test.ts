// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { RESPONSES_PATH, type ResolvedModel } from "@zeroroot-ai/sdk"

import { gatewayProvider, modelSelector, modelSlot, resolveProvider } from "./model-provider.js"
import { makeCa, withHttpServer, withTlsGateway } from "./tls-fixture.test.js"

type ProviderOptions = { baseURL: string; apiKey: string; fetch: typeof fetch }
type ProviderModels = Record<string, { id: string; limit?: { context: number; output: number } }>

// One CA for the file. Each test starts its own server with a certificate of this CA.
const ca = makeCa("gateway-ca")

const reply = (gatewayUrl: string, extra: Partial<ResolvedModel> = {}): ResolvedModel => ({
  model: "claude-sonnet-x",
  provider: "tenant-provider",
  gatewayUrl,
  routeHeaders: { "x-route-model": "claude-sonnet-x", "x-route-tenant": "t1" },
  contextWindow: 200000,
  maxOutputTokens: 8192,
  gatewayCaPem: ca.pem,
  ...extra,
})

/** Send the call that the AI SDK makes for an Open Responses turn. */
async function turn(provider: Record<string, unknown>, url?: string): Promise<Response> {
  const options = provider.options as ProviderOptions
  return await options.fetch(url ?? `${options.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({ model: "claude-sonnet-x", input: [] }),
  })
}

test("a turn calls POST {gatewayUrl}/v1/responses with the grant and the route headers of the reply", async () => {
  await withTlsGateway(ca, async (url, seen) => {
    const res = await turn(gatewayProvider(reply(url), "primary", () => "grant-1"))
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

test("a trailing slash on the gateway URL does not change the route", async () => {
  await withTlsGateway(ca, async (url, seen) => {
    await turn(gatewayProvider(reply(`${url}/`), "primary", () => "g"))
    assert.equal(seen[0]?.url, RESPONSES_PATH)
  })
})

test("the plugin resolves the slot with resolveModel and sends the grant of the harness", async () => {
  await withTlsGateway(ca, async (url, seen) => {
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
    await turn(provider)
    grant = "task-grant-2"
    await turn(provider)
    assert.deepEqual(
      seen.map((s) => s.headers["x-capability-grant"]),
      ["task-grant-1", "task-grant-2"],
      "a renewal reaches the gateway",
    )
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

test("an empty grant fails the call before it is sent", async () => {
  await withTlsGateway(ca, async (url, seen) => {
    await assert.rejects(() => turn(gatewayProvider(reply(url), "primary", () => "")), /grant is empty/)
    assert.equal(seen.length, 0)
  })
})

test("a call to another origin is refused, so the grant goes to the gateway only", async () => {
  await withTlsGateway(ca, async (url, seen) => {
    await withTlsGateway(ca, async (other, otherSeen) => {
      const provider = gatewayProvider(reply(url), "primary", () => "grant-1")
      await assert.rejects(() => turn(provider, `${other}/v1/responses`), /refused a call to/)
      assert.equal(otherSeen.length, 0, "the other server saw nothing")
      assert.equal(seen.length, 0)
    })
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

test("a gateway URL that is not https is refused, with a CA bundle and without one", async () => {
  await withHttpServer(async (url, seen) => {
    assert.throws(() => gatewayProvider(reply(url, { gatewayCaPem: ca.pem }), "primary", () => "g"), /https/)
    assert.throws(() => gatewayProvider(reply(url, { gatewayCaPem: "" }), "primary", () => "g"), /https/)
    assert.equal(seen.length, 0)
  })
  assert.throws(() => gatewayProvider(reply("not a url"), "primary", () => "g"), /not a URL/)
})

test("the plugin trusts the CA bundle of the reply for the gateway", async () => {
  await withTlsGateway(ca, async (url, seen) => {
    const res = await turn(gatewayProvider(reply(url, { gatewayCaPem: ca.pem }), "primary", () => "g"))
    assert.equal(res.status, 200)
    assert.equal(seen[0]?.headers["x-capability-grant"], "g")
  })
})

test("the plugin trusts only the CA bundle of the reply", async () => {
  const otherCa = makeCa("other-ca")
  await withTlsGateway(ca, async (url, seen) => {
    // The bundle names another CA, so the certificate of this gateway fails.
    await assert.rejects(() => turn(gatewayProvider(reply(url, { gatewayCaPem: otherCa.pem }), "primary", () => "g")))
    assert.equal(seen.length, 0, "no request, and so no grant, reached a server the bundle does not vouch for")
  })
})

test("with no bundle in the reply the plugin uses the system roots, so a private CA fails", async () => {
  await withTlsGateway(ca, async (url, seen) => {
    await assert.rejects(() => turn(gatewayProvider(reply(url, { gatewayCaPem: "" }), "primary", () => "g")))
    assert.equal(seen.length, 0)
  })
})

test("the model of the gateway provider is gibson/<slot>, from GIBSON_MODEL_SLOT or primary", () => {
  assert.equal(modelSlot({}), "primary")
  assert.equal(modelSelector({}), "gibson/primary")
  assert.equal(modelSelector({ GIBSON_MODEL_SLOT: "review" }), "gibson/review")
  assert.equal(modelSlot({ GIBSON_MODEL_SLOT: "" }), "primary", "an empty value is no value")
})
