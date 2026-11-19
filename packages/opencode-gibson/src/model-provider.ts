// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { gatewayFetch, staticGrantHeaders, type ResolvedModel } from "@zeroroot-ai/sdk"

/** The slot the plugin resolves when `GIBSON_MODEL_SLOT` is not set. */
export const DEFAULT_MODEL_SLOT = "primary"

/** The opencode provider id. A user selects a model as `gibson/<slot>`. */
export const PROVIDER_ID = "gibson"

/**
 * Build the opencode provider for the Model gateway.
 *
 * The provider uses `@ai-sdk/openai`, which sends Open Responses calls to
 * `{baseURL}/responses`. The base URL is the gateway URL of the reply with
 * `/v1` added, so the call goes to `{gatewayUrl}/v1/responses`.
 *
 * The `fetch` option is the one place where the call leaves the process. The
 * SDK gateway fetch adds the route headers of the reply and the current task
 * grant in `x-capability-grant`. It trusts exactly the CA bundle of the reply,
 * and the system roots when the reply has none. It does not follow a redirect.
 * The placeholder key of the AI SDK becomes an `authorization` header, so this
 * function removes it. Only the grant authenticates the call.
 *
 * `grant` returns the current grant, because the harness renews it.
 */
export function gatewayProvider(resolved: ResolvedModel, slot: string, grant: () => string): Record<string, unknown> {
  const send = gatewayFetch({
    baseUrl: resolved.gatewayUrl,
    caPem: resolved.gatewayCaPem,
    fixedHeaders: resolved.routeHeaders,
    headers: staticGrantHeaders(grant),
  })
  const fetchWithoutPlaceholderKey: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    request.headers.delete("authorization")
    return await send(request)
  }
  return {
    npm: "@ai-sdk/openai",
    name: "Gibson",
    options: {
      baseURL: `${resolved.gatewayUrl.replace(/\/+$/, "")}/v1`,
      apiKey: "gibson",
      fetch: fetchWithoutPlaceholderKey,
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
