import type { Hooks, Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { connectGibson, startCompletionsShim, type GibsonSession, type RunningShim } from "@zerocool/sdk"
import { homedir } from "node:os"
import { join } from "node:path"
import { componentizeTool, enrollComponentTool } from "./componentize.js"
import { delegationTools } from "./delegate.js"
import { buildGibsonTools } from "./gibson-tools.js"
import { ambientKnowledge, recallTool } from "./knowledge.js"
import {
  gibsonFindingsBackend,
  localFindingsBackend,
  submitFindingTool,
  type SessionContext,
} from "./findings.js"

/**
 * @zerocool/opencode-gibson — the main Gibson plugin.
 *
 * Standalone (no Gibson key), opencode is almost unchanged: the agent gets a
 * local findings log and a componentize tool, and nothing else. With a Gibson
 * bootstrap key it also:
 *   - checks in as a Gibson component (Capability Grant + RegisterComponent + heartbeat),
 *   - starts a local OpenAI-compatible shim over the harness,
 *   - auto-registers a zero-config `gibson` provider via the `config` hook (#6),
 *   - emits findings into the tenant World (#7),
 *   - reads the tenant knowledge graph (#8),
 *   - exposes Gibson tools and plugins as opencode tools (#9),
 *   - delegates to other agents and drives missions (#10),
 *   - enrolls produced artifacts into the fleet (#11).
 *
 * The plugin fails open throughout. A coding agent that cannot reach its
 * platform must still be a working coding agent, so every platform failure
 * degrades to the standalone behaviour instead of refusing to start.
 */
export const GibsonPlugin: Plugin = async () => {
  const bootstrapToken = process.env.GIBSON_BOOTSTRAP_TOKEN
  const platformURL = process.env.GIBSON_PLATFORM_URL
  const context: SessionContext = {}

  // Standalone: findings go to a local log, and componentize still works —
  // producing a manifest needs no platform.
  const standaloneTools = (): Record<string, ToolDefinition> => ({
    submit_finding: submitFindingTool(
      localFindingsBackend(
        process.env.ZEROCOOL_FINDINGS_LOG ?? join(homedir(), ".zerocool", "findings.jsonl"),
      ),
      context,
    ),
    gibson_componentize: componentizeTool(),
  })

  if (!bootstrapToken || !platformURL) {
    return { tool: standaloneTools() } satisfies Hooks
  }

  let session: GibsonSession | undefined
  let shim: RunningShim | undefined
  try {
    session = await connectGibson({
      platformURL,
      daemonURL: process.env.GIBSON_DAEMON_URL,
      bootstrapToken,
      hostKeyPath: process.env.GIBSON_HOST_KEY_PATH ?? join(homedir(), ".zerocool", "host.key"),
      agentName: "zerocool",
      agentMode: process.env.GIBSON_AGENT_MODE ?? "autonomous",
      agent: { name: "zerocool", version: "0.0.0", capabilities: ["code"] },
    })
    shim = await startCompletionsShim({
      component: session.clients.component,
      port: Number(process.env.GIBSON_SHIM_PORT ?? 8787),
    })
    console.error(
      `[zerocool] Gibson connected (component_scope=${session.componentScope}); ` +
        `provider "gibson" auto-configured at ${shim.url} — select a gibson/<slot> model`,
    )
  } catch (e) {
    // Fail open to standalone: a coding agent must still work if the platform is unreachable.
    console.error(`[zerocool] Gibson connect failed; continuing standalone: ${(e as Error).message}`)
    await shim?.close()
    return { tool: standaloneTools() } satisfies Hooks
  }

  const shimUrl = shim.url
  const live = session

  // Tool discovery runs once at load — opencode reads the `tool` hook as a
  // static object, so a tool registered mid-session would never reach the model.
  const gibson = await buildGibsonTools(live)
  if (gibson.note) console.error(`[zerocool] Gibson tool discovery: ${gibson.note}`)
  else console.error(`[zerocool] ${gibson.discovered} Gibson tool(s) registered`)

  const tools: Record<string, ToolDefinition> = {
    submit_finding: submitFindingTool(gibsonFindingsBackend(live), context),
    recall: recallTool(live),
    gibson_componentize: componentizeTool(),
    gibson_enroll_component: enrollComponentTool(live),
    ...gibson.tools,
    ...delegationTools(live),
  }

  const injectKnowledge = ambientKnowledge(
    live,
    process.env.ZEROCOOL_AMBIENT_QUERY ?? "prior findings and security facts for this codebase",
  )

  return {
    tool: tools,

    // Zero-config LLM: inject the Gibson provider at config-load time (#6).
    //
    // `shimUrl` is always live here, and that is a type-level guarantee rather
    // than a timing assumption: `Plugin` returns `Promise<Hooks>`, so opencode
    // cannot reach this hook until the plugin body has resolved — and the body
    // starts the shim before it builds this object. There is no ordering in
    // which `config` runs against an unstarted shim.
    config: async (config) => {
      const cfg = config as unknown as { provider?: Record<string, unknown> }
      cfg.provider = cfg.provider ?? {}
      if (!cfg.provider.gibson) {
        cfg.provider.gibson = {
          npm: "@ai-sdk/openai-compatible",
          name: "Gibson",
          options: { baseURL: shimUrl, apiKey: "gibson" },
        }
      }
    },

    // Ambient knowledge (#8): one cached GraphRAG lookup per session, injected
    // into the system prompt from the second turn on.
    "experimental.chat.system.transform": injectKnowledge,

    // Track the session so findings carry provenance (#7). This hook does not
    // emit findings: a file edit is not a security finding, and inventing one
    // would fill the tenant graph with noise a human then has to triage.
    event: async ({ event }) => {
      const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
      if (sessionID) context.sessionID = sessionID
    },

    dispose: async () => {
      session?.stop()
      await shim?.close()
    },
  } satisfies Hooks
}

export default GibsonPlugin
