import type { ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  formatKnowledgeForPrompt,
  isUnimplemented,
  queryKnowledge,
  type GibsonSession,
  type KnowledgeHit,
} from "@zerocool/sdk"

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

export function recallTool(session: GibsonSession): ToolDefinition {
  const z = tool.schema
  return tool({
    description:
      "Search this tenant's Gibson knowledge graph for prior findings, targets and " +
      "security facts recorded by earlier runs. Use it before starting work on an " +
      "unfamiliar area, or to check whether an issue was already reported.",
    args: {
      query: z.string().describe("What to look for, in natural language."),
      limit: z.number().min(1).max(50).optional().describe("Maximum hits to return. Defaults to 10."),
      node_types: z
        .array(z.string())
        .optional()
        .describe('Restrict to node types, e.g. ["finding"] or ["host", "technique"].'),
    },
    async execute(args) {
      let hits: KnowledgeHit[]
      try {
        hits = await queryKnowledge(session.clients.component, {
          text: args.query,
          topK: args.limit ?? 10,
          ...(args.node_types ? { nodeTypes: args.node_types } : {}),
        })
      } catch (e) {
        if (isUnimplemented(e)) {
          return {
            title: "recall unavailable",
            output:
              "The Gibson knowledge graph is not available on this daemon: the GraphRAG " +
              "seam is not wired (gibson#1186). Continue without prior context.",
          }
        }
        throw e
      }

      if (hits.length === 0) {
        return { title: "no matches", output: `Nothing in the tenant graph matches "${args.query}".` }
      }

      return {
        title: `${hits.length} match${hits.length === 1 ? "" : "es"}`,
        output: formatKnowledgeForPrompt(hits),
        metadata: { hit_count: hits.length, node_types: [...new Set(hits.map((h) => h.type))] },
      }
    },
  })
}

/**
 * Per-session ambient knowledge for the system prompt.
 *
 * Returns a transform that injects a short context block once a session has
 * produced one. The lookup is fired once and cached, so a session pays for at
 * most one GraphRAG query no matter how many turns it runs.
 */
export function ambientKnowledge(session: GibsonSession, seedQuery: string) {
  const cache = new Map<string, string>()
  const inFlight = new Map<string, Promise<string>>()

  const load = async (key: string): Promise<string> => {
    try {
      const hits = await queryKnowledge(session.clients.component, {
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
