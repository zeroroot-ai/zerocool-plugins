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

/** A fake harness of a granted run: the model resolver, the grant and the stop. */
interface FakeHarness {
  resolveModel: (slot: string) => Promise<ResolvedModel>
  token: () => string
}

/** The platform calls of a plugin. A granted run must never check in, so `connect` fails the test. */
function deps(harness?: FakeHarness): PluginDeps & { stops: string[]; checkedIn: number } {
  const stops: string[] = []
  const d = {
    stops,
    checkedIn: 0,
    connect: (async () => {
      d.checkedIn += 1
      return { componentScope: "c", stop: () => stops.push("session") }
    }) as never,
    selectKnowledge: (() => ({ knowledge: {}, scope: "component", stop: () => stops.push("knowledge") })) as never,
    ...(harness
      ? { openHarness: (() => ({ ...harness, stop: () => stops.push("harness") })) as never }
      : {}),
  }
  return d
}

/**
 * The environment of a sandboxed dispatched child, exactly. The launcher
 * (gibson `internal/engine/harness/sandboxed/agent_member.go`) writes the grant,
 * the endpoint and the run ids. It writes no `GIBSON_PLATFORM_URL`, no host key
 * and no bootstrap token. The driver renames the grant for the child.
 */
const SANDBOX_CHILD_ENV: NodeJS.ProcessEnv = {
  GIBSON_CALLBACK_ENDPOINT: "https://api.example.test",
  GIBSON_CALLBACK_TOKEN: "task-grant",
  GIBSON_MISSION_RUN_ID: "run-1",
  GIBSON_AGENT_RUN_ID: "ar-1",
  GIBSON_TRACE_ID: "tr-1",
  PATH: "/usr/bin",
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
        SANDBOX_CHILD_ENV,
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
      { ...SANDBOX_CHILD_ENV, GIBSON_MODEL_SLOT: "review" },
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
    await assert.rejects(() => createGibsonPlugin(d, SANDBOX_CHILD_ENV), /did not resolve slot "primary": no model for slot/)
    assert.deepEqual(d.stops, ["harness"], "the grant timer stops")
  })
})

test("a run with no task grant registers no provider and selects no model", async () => {
  await withEnv({}, async () => {
    const hooks = await createGibsonPlugin(deps(undefined), process.env)
    const config: Config = { model: "anthropic/claude-sonnet-x" }
    await hooks.config?.(config as never)
    assert.equal(config.provider?.gibson, undefined)
    assert.equal(config.model, "anthropic/claude-sonnet-x", "the model of the user stays")
    assert.ok(config.mcp?.gibson)
  })
})

test("a sandboxed granted run registers the provider with no platform URL, no host key and no check-in", async () => {
  const d = deps({ resolveModel: async () => reply("https://gw.example"), token: () => "task-grant" })
  const hooks = await createGibsonPlugin(d, SANDBOX_CHILD_ENV)
  const config: Config = {}
  await hooks.config?.(config as never)
  assert.equal(d.checkedIn, 0, "the granted run does not check in as a component")
  assert.equal(config.model, "gibson/primary")
  assert.ok(config.provider?.gibson)
  await hooks.dispose?.()
  assert.deepEqual(d.stops, ["harness"], "the harness stops, and there is no session to stop")
})

test("a granted run opens the harness from the callback variables of the environment", async () => {
  const seen: { slot?: string; endpoint?: string; token?: string; insecure?: boolean } = {}
  const d: PluginDeps = {
    connect: (async () => assert.fail("no check-in")) as never,
    selectKnowledge: (() => assert.fail("no component knowledge")) as never,
    openHarness: ((opts: { endpoint: string; token: string; insecure?: boolean }) => {
      Object.assign(seen, { endpoint: opts.endpoint, token: opts.token, insecure: opts.insecure })
      return {
        resolveModel: async (slot: string) => {
          seen.slot = slot
          return reply("https://gw.example")
        },
        token: () => opts.token,
        stop: () => {},
      }
    }) as never,
  }
  const hooks = await createGibsonPlugin(d, { ...SANDBOX_CHILD_ENV, GIBSON_CALLBACK_INSECURE: "1" })
  const config: Config = {}
  await hooks.config?.(config as never)
  assert.deepEqual(seen, { endpoint: "https://api.example.test", token: "task-grant", insecure: true, slot: "primary" })
  assert.equal(config.provider?.gibson?.models?.primary?.id, "claude-sonnet-x")
  await hooks.dispose?.()
})

test("a granted run with the grant and no endpoint, or the reverse, fails", async () => {
  await assert.rejects(() => createGibsonPlugin(deps(), { GIBSON_CALLBACK_TOKEN: "g" }), /must both be set/)
  await assert.rejects(() => createGibsonPlugin(deps(), { GIBSON_CALLBACK_ENDPOINT: "https://x" }), /must both be set/)
})

test("a granted run locks opencode to the gibson provider, whatever the user config names", async () => {
  const d = deps({ resolveModel: async () => reply("https://gw.example"), token: () => "task-grant" })
  const hooks = await createGibsonPlugin(d, SANDBOX_CHILD_ENV)
  // A user config with a direct provider, a stored-key style provider, a model
  // for each agent and command, and the gateway provider disabled.
  const config = {
    model: "anthropic/claude-sonnet-x",
    small_model: "openai/gpt-x",
    provider: { anthropic: { options: { apiKey: "sk-user" } }, openai: {} },
    disabled_providers: ["gibson", "other"],
    agent: {
      build: { model: "anthropic/claude-opus-x", prompt: "keep" },
      review: { model: "openai/gpt-x" },
      plan: {},
    },
    command: { fix: { model: "anthropic/claude-x", template: "keep" } },
    mode: { old: { model: "anthropic/claude-x" } },
  }
  await hooks.config?.(config as never)
  assert.deepEqual((config as { enabled_providers?: string[] }).enabled_providers, ["gibson"])
  assert.deepEqual(Object.keys(config.provider), ["gibson"], "no direct provider and no key of the user stays")
  assert.deepEqual(config.disabled_providers, ["other"], "gibson is not disabled")
  assert.equal(config.model, "gibson/primary")
  assert.equal(config.small_model, "gibson/primary")
  assert.equal(config.agent.build.model, undefined, "the agent uses the top-level model")
  assert.equal(config.agent.build.prompt, "keep", "the rest of the agent stays")
  assert.equal(config.agent.review.model, undefined)
  assert.equal(config.command.fix.model, undefined)
  assert.equal(config.command.fix.template, "keep")
  assert.equal(config.mode.old.model, undefined)
})

test("an interactive run leaves the providers and the agent models of the user alone", async () => {
  await withEnv({}, async () => {
    const hooks = await createGibsonPlugin(deps(undefined), process.env)
    const config = { agent: { build: { model: "anthropic/x" } }, provider: { anthropic: {} } }
    await hooks.config?.(config as never)
    assert.equal(config.agent.build.model, "anthropic/x")
    assert.deepEqual(Object.keys(config.provider), ["anthropic"])
    assert.equal((config as { enabled_providers?: string[] }).enabled_providers, undefined)
  })
})

test("an interactive run reads the env parameter, not the process environment", async () => {
  const seen: { platformURL?: string; agentName?: string } = {}
  const d = deps()
  d.connect = (async (cfg: { platformURL: string; agentName?: string }) => {
    seen.platformURL = cfg.platformURL
    seen.agentName = cfg.agentName
    return { componentScope: "c", stop: () => {} }
  }) as never
  const dir = await mkdtemp(join(tmpdir(), "zerocool-plugin-"))
  await withEnv({ GIBSON_PLATFORM_URL: undefined, GIBSON_BOOTSTRAP_TOKEN: undefined }, async () => {
    await createGibsonPlugin(d, {
      GIBSON_PLATFORM_URL: "https://from-param.example",
      GIBSON_BOOTSTRAP_TOKEN: "one-time",
      GIBSON_HOST_KEY_PATH: join(dir, "no-host.key"),
      GIBSON_AGENT_NAME: "from-param",
    })
  })
  assert.deepEqual(seen, { platformURL: "https://from-param.example", agentName: "from-param" })
})
