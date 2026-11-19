// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { gatewayFetch, type HeaderFunc, type ResolvedModel } from "@zeroroot-ai/sdk"

/** The slot the plugin resolves when `GIBSON_MODEL_SLOT` is not set. */
export const DEFAULT_MODEL_SLOT = "primary"

/** The opencode provider id. A user selects a model as `gibson/<slot>`. */
export const PROVIDER_ID = "gibson"

/** The slot of this process. The plugin and the dispatch driver read it the same way. */
export function modelSlot(env: NodeJS.ProcessEnv = process.env): string {
  return env.GIBSON_MODEL_SLOT || DEFAULT_MODEL_SLOT
}

/**
 * The opencode model id of the gateway provider, `gibson/<slot>`. The dispatch
 * driver passes it as `--model`, and the `config` hook sets it as `model`.
 * The launcher sets `GIBSON_MODEL` to a bare tenant model name. That name is
 * not a model of this provider, so nothing selects it.
 */
export function modelSelector(env: NodeJS.ProcessEnv = process.env): string {
  return `${PROVIDER_ID}/${modelSlot(env)}`
}

/**
 * Build the opencode provider for the Model gateway.
 *
 * The provider uses `@ai-sdk/openai`, which sends Open Responses calls to
 * `{baseURL}/responses`. The base URL is the gateway URL of the reply with
 * `/v1` added, so the call goes to `{gatewayUrl}/v1/responses`.
 *
 * The `fetch` option is the one place where the call leaves the process.
 * opencode keeps a function in `options.fetch` and wraps it. This was checked
 * against opencode 1.18.23: a plugin `config` hook set `options.fetch`, and a
 * fake gateway received the headers that the function added, on
 * `/v1/responses`, with the model id of the `id` field. opencode takes
 * `let { fetch } = options` and calls it as `fetch ?? globalThis.fetch`.
 *
 * The fetch function has these rules:
 *  - It refuses a request whose origin is not the origin of the gateway URL.
 *  - It adds the route headers of the reply and the current task grant in
 *    `x-capability-grant`. It throws when the grant is empty.
 *  - It trusts exactly the CA bundle of the reply, and the system roots when
 *    the reply has none. It does not follow a redirect.
 *  - It removes the `authorization` header, which the placeholder key of the AI
 *    SDK creates. Only the grant authenticates the call.
 *
 * The gateway URL must use https. The SDK model client (`harness.model`) does
 * not serve here, because it returns a client and opencode needs a `fetch`.
 * This uses `gatewayFetch` of the SDK, so the trust rule has one implementation.
 *
 * `grant` returns the current grant, because the harness renews it.
 */
export function gatewayProvider(resolved: ResolvedModel, slot: string, grant: () => string): Record<string, unknown> {
  const gateway = parseGatewayUrl(resolved.gatewayUrl)
  const grantHeaders: HeaderFunc = () => {
    const token = grant()
    if (!token) throw new Error("the task grant is empty: no call goes to the Model gateway without it")
    return { "x-capability-grant": token }
  }
  const send = gatewayFetch({
    baseUrl: resolved.gatewayUrl,
    caPem: resolved.gatewayCaPem,
    fixedHeaders: resolved.routeHeaders,
    headers: grantHeaders,
  })
  const guardedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const target = new URL(request.url)
    if (target.origin !== gateway.origin) {
      throw new Error(`refused a call to ${target.origin}: the Model gateway is ${gateway.origin}`)
    }
    request.headers.delete("authorization")
    return await send(request)
  }
  return {
    npm: "@ai-sdk/openai",
    name: "Gibson",
    options: {
      baseURL: `${gateway.origin}${gateway.pathname.replace(/\/+$/, "")}/v1`,
      apiKey: "gibson",
      fetch: guardedFetch,
    },
    models: {
      [slot]: {
        id: resolved.model,
        name: `Gibson ${slot} (${resolved.model})`,
        ...(resolved.contextWindow > 0 || resolved.maxOutputTokens > 0
          ? { limit: { context: resolved.contextWindow, output: resolved.maxOutputTokens } }
          : {}),
      },
    },
  }
}

/** Refuse a gateway URL that is not https, with or without a CA bundle. */
function parseGatewayUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch (cause) {
    throw new Error(`the Model gateway URL is not a URL: ${JSON.stringify(raw)}`, { cause })
  }
  if (url.protocol !== "https:") {
    throw new Error(`the Model gateway URL must use https, not ${url.protocol.replace(":", "")}`)
  }
  return url
}

/** What the provider needs from a task harness. */
export interface ModelResolver {
  resolveModel(slot: string): Promise<ResolvedModel>
  token(): string
}

/**
 * Resolve a slot to one model with `resolveModel` and build the provider for
 * it. The grant comes from the harness on each call, so a renewal reaches the
 * gateway.
 */
export async function resolveProvider(harness: ModelResolver, slot: string): Promise<Record<string, unknown>> {
  return gatewayProvider(await harness.resolveModel(slot), slot, () => harness.token())
}
