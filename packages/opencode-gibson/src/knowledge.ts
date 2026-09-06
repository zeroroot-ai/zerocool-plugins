// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import {
  formatKnowledgeForPrompt,
  type KnowledgeSource,
} from "@zeroroot-ai/sdk"

/**
 * Knowledge — read the tenant graph so the agent sharpens across runs
 * (zerocool-plugins#8).
 *
 * Two surfaces, because opencode offers two and they answer different needs:
 *
 *  - a **`recall` tool**, which the model calls when it wants prior context.
 *    This is the primary path: the model knows when a lookup is worth a round
 *    trip, and the query it writes is better than anything derived from the
 *    prompt.
 *  - a **`system.transform` hook**, which injects a small ambient block once
 *    per session. `experimental.chat.system.transform` runs on every request,
 *    so an un-cached GraphRAG query there would add a network round trip to
 *    every single turn. {@link ambientKnowledge} caches per session and injects
 *    nothing until the first successful lookup.
 *
 * All reads are tenant-scoped server-side; there is no tenant argument to get
 * wrong. Standalone, both surfaces are absent — the plugin does not register
 * them without a Gibson session.
 */

/** How many hits the ambient block injects. Kept small — it is prompt overhead. */
const AMBIENT_LIMIT = 5

export function ambientKnowledge(knowledge: KnowledgeSource, seedQuery: string) {
  const cache = new Map<string, string>()
  const inFlight = new Map<string, Promise<string>>()

  const load = async (_key: string): Promise<string> => {
    try {
      const hits = await knowledge.query({
        text: seedQuery,
        topK: AMBIENT_LIMIT,
      })
      return formatKnowledgeForPrompt(hits)
    } catch {
      // A knowledge failure must never break a chat turn — the agent works
      // without prior context, it just works less well.
      return ""
    }
  }

  return async (
    input: { sessionID?: string },
    output: { system: string[] },
  ): Promise<void> => {
    const key = input.sessionID ?? "default"

    const cached = cache.get(key)
    if (cached) {
      output.system.push(cached)
      return
    }

    // Fire the lookup once per session and let this turn proceed without it;
    // blocking the first turn on a graph query would be felt as latency on
    // every new session.
    if (!inFlight.has(key)) {
      const p = load(key).then((block) => {
        if (block) cache.set(key, block)
        inFlight.delete(key)
        return block
      })
      inFlight.set(key, p)
    }
  }
}
