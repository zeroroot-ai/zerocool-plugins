// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { ResolvedModel } from "@zeroroot-ai/sdk"

import { createGibsonPlugin, type PluginDeps } from "./gibson-plugin.js"
import { makeCa, withTlsGateway } from "./tls-fixture.test.js"

/** The real plugin `config` hook, with the platform calls replaced by fakes. */

const ca = makeCa("gateway-ca")

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const keys = ["GIBSON_PLATFORM_URL", "GIBSON_BOOTSTRAP_TOKEN", "GIBSON_HOST_KEY_PATH", "GIBSON_MODEL_SLOT"]
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  const dir = await mkdtemp(join(tmpdir(), "zerocool-plugin-"))
  const merged: Record<string, string | undefined> = {
    GIBSON_PLATFORM_URL: "https://platform.example",
    GIBSON_BOOTSTRAP_TOKEN: "one-time",
    GIBSON_HOST_KEY_PATH: join(dir, "no-host.key"),
    GIBSON_MODEL_SLOT: undefined,
    ...env,
  }
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function deps(harness: { resolveModel: (slot: string) => Promise<ResolvedModel>; token: () => string } | undefined): PluginDeps & { stops: string[] } {
  const stops: string[] = []
  return {
    stops,
    connect: (async () => ({ componentScope: "c", stop: () => stops.push("session") })) as never,
    selectKnowledge: (() => ({
      knowledge: {},
      scope: harness ? "task" : "component",
      ...(harness ? { harness } : {}),
      stop: () => stops.push("knowledge"),
    })) as never,
  }
}

type Config = {
  model?: string
  small_model?: string
  provider?: Record<string, { options?: { fetch: typeof fetch; baseURL: string; apiKey: string }; models?: Record<string, { id: string }> }>
  mcp?: Record<string, unknown>
}

const reply = (gatewayUrl: string): ResolvedModel => ({
  model: "claude-sonnet-x",
  provider: "tenant-provider",
  gatewayUrl,
  routeHeaders: { "x-route-tenant": "t1" },
  contextWindow: 0,
  maxOutputTokens: 0,
  gatewayCaPem: ca.pem,
})

test("the config hook selects gibson/<slot> and its fetch reaches the gateway with the headers of the reply", async () => {
  await withTlsGateway(ca, async (url, seen) => {
    await withEnv({}, async () => {
      const slots: string[] = []
      const hooks = await createGibsonPlugin(
        deps({
          resolveModel: async (slot) => {
            slots.push(slot)
            return reply(url)
          },
          token: () => "task-grant",
        }),
      )
      // The config of the user holds a direct provider and a bare model. The dispatch wins.
      const config: Config = { model: "anthropic/claude-sonnet-x", provider: { gibson: { models: {} } } }
      await hooks.config?.(config as never)

      assert.deepEqual(slots, ["primary"])
      assert.equal(config.model, "gibson/primary")
      assert.equal(config.small_model, "gibson/primary")
      assert.equal(config.provider?.gibson?.models?.primary?.id, "claude-sonnet-x")
      assert.ok(config.mcp?.gibson, "the MCP server is still registered")

      const options = config.provider?.gibson?.options
      assert.ok(options)
      const res = await options.fetch(`${options.baseURL}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: "claude-sonnet-x", input: [] }),
      })
      assert.equal(res.status, 200)
      assert.equal(seen[0]?.url, "/v1/responses")
      assert.equal(seen[0]?.headers["x-capability-grant"], "task-grant")
      assert.equal(seen[0]?.headers["x-route-tenant"], "t1")
      assert.equal(seen[0]?.headers.authorization, undefined)
    })
  })
})

test("GIBSON_MODEL_SLOT names the slot that the hook resolves and selects", async () => {
  await withEnv({ GIBSON_MODEL_SLOT: "review" }, async () => {
    const slots: string[] = []
    const hooks = await createGibsonPlugin(
      deps({
        resolveModel: async (slot) => {
          slots.push(slot)
          return reply("https://gw.example")
        },
        token: () => "g",
      }),
    )
    const config: Config = {}
    await hooks.config?.(config as never)
    assert.deepEqual(slots, ["review"])
    assert.equal(config.model, "gibson/review")
  })
})

test("a dispatched run whose slot does not resolve fails, and does not continue on a direct key", async () => {
  await withEnv({}, async () => {
    const d = deps({
      resolveModel: async () => {
        throw new Error("no model for slot")
      },
      token: () => "g",
    })
    await assert.rejects(() => createGibsonPlugin(d), /did not resolve slot "primary": no model for slot/)
    assert.deepEqual(d.stops, ["knowledge", "session"], "the grant timer and the session stop")
  })
})

test("a run with no task grant registers no provider and selects no model", async () => {
  await withEnv({}, async () => {
    const hooks = await createGibsonPlugin(deps(undefined))
    const config: Config = { model: "anthropic/claude-sonnet-x" }
    await hooks.config?.(config as never)
    assert.equal(config.provider?.gibson, undefined)
    assert.equal(config.model, "anthropic/claude-sonnet-x", "the model of the user stays")
    assert.ok(config.mcp?.gibson)
  })
})
