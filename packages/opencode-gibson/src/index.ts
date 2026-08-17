import type { Hooks, Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { connectGibson, startCompletionsShim, type GibsonSession, type RunningShim } from "@zeroroot-ai/sdk"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { componentizeTool, enrollComponentTool } from "./componentize.js"
import { delegationTools } from "./delegate.js"
import { buildGibsonTools } from "./gibson-tools.js"
import { ambientKnowledge, recallTool } from "./knowledge.js"
import { selectKnowledgeSource } from "./knowledge-source.js"
import {
  gibsonFindingsBackend,
  localFindingsBackend,
  submitFindingTool,
  type SessionContext,
} from "./findings.js"

/**
 * @zeroroot-ai/zerocool — the main Gibson plugin.
 *
 * ENROLLMENT — check in once, then run unattended. A human enrolls this host
 * one time:
 *
 *   gibson login                                  # device flow, in a browser
 *   gibson agent enroll                           # prints a ONE-TIME token
 *   GIBSON_BOOTSTRAP_TOKEN=<token> opencode       # first start only
 *
 * That first start completes the Capability Grant handshake and persists a host
 * key. Every later start re-registers with that key and needs no token and no
 * human. This is the platform's design (ADR-0045), not a limitation to work
 * around: a coding agent joins a tenant's fleet on a person's authority, once.
 *
 * Standalone (never enrolled), opencode is almost unchanged: the agent gets a
 * local findings log and a componentize tool, and nothing else. Enrolled, it
 * also:
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
  const platformURL = process.env.GIBSON_PLATFORM_URL
  const hostKeyPath = process.env.GIBSON_HOST_KEY_PATH ?? join(homedir(), ".zerocool", "host.key")
  const context: SessionContext = {}

  // Check in once, then run unattended — the platform's enrollment model
  // (ADR-0045). A human runs `gibson login` and `gibson agent enroll` once and
  // hands over the resulting ONE-TIME bootstrap token. That token completes the
  // first Capability Grant handshake and the host key it registers is persisted
  // at `hostKeyPath`. Every later start re-registers by proving possession of
  // that host key — the daemon routes on credential type: `host+jwt` is
  // re-registration, anything else is first registration
  // (gibson `internal/server/daemon/capabilitygrant_register.go:134-155`).
  //
  // So the bootstrap token is passed ONLY when no host key exists yet. Replaying
  // a one-time token on every start would be rejected, and it would mean asking
  // the operator to keep a spent credential in their environment forever.
  const checkedIn = existsSync(hostKeyPath)
  const bootstrapToken = checkedIn ? undefined : process.env.GIBSON_BOOTSTRAP_TOKEN

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

  // Standalone unless we can authenticate: a platform URL plus either a token
  // for the first check-in or an already-registered host key.
  if (!platformURL || (!bootstrapToken && !checkedIn)) {
    if (platformURL && !checkedIn) {
      console.error(
        "[zerocool] GIBSON_PLATFORM_URL is set but this host has not checked in. " +
          "Run `gibson login` then `gibson agent enroll`, and start once with " +
          "GIBSON_BOOTSTRAP_TOKEN=<one-time token>. After that the host key at " +
          `${hostKeyPath} is enough — you can drop the token.`,
      )
    }
    return { tool: standaloneTools() } satisfies Hooks
  }

  let session: GibsonSession | undefined
  let shim: RunningShim | undefined
  try {
    session = await connectGibson({
      platformURL,
      daemonURL: process.env.GIBSON_DAEMON_URL,
      bootstrapToken,
      hostKeyPath,
      agentName: "zerocool",
      agentMode: process.env.GIBSON_AGENT_MODE ?? "autonomous",
      agent: { name: "zerocool", version: "0.0.0", capabilities: ["code"] },
    })
    shim = await startCompletionsShim({
      component: session.clients.component,
      port: Number(process.env.GIBSON_SHIM_PORT ?? 8787),
    })
    console.error(
      `[zerocool] Gibson connected via ${checkedIn ? "the registered host key" : "first check-in"} ` +
        `(component_scope=${session.componentScope}); provider "gibson" auto-configured at ` +
        `${shim.url} — select a gibson/<slot> model`,
    )
    if (!checkedIn) {
      console.error(
        `[zerocool] Host key written to ${hostKeyPath}. The bootstrap token is spent — ` +
          "unset GIBSON_BOOTSTRAP_TOKEN; later starts re-register with the host key.",
      )
    }
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
  // Which grant this process reads the knowledge graph with. A dispatched run
  // reads as the TASK; an interactive one keeps the component grant. Chosen once
  // here so nothing downstream has to ask.
  const { knowledge, scope: knowledgeScope } = selectKnowledgeSource(live)
  console.error(`[zerocool] knowledge reads use the ${knowledgeScope} grant`)

  const gibson = await buildGibsonTools(live)
  if (gibson.note) console.error(`[zerocool] Gibson tool discovery: ${gibson.note}`)
  else console.error(`[zerocool] ${gibson.discovered} Gibson tool(s) registered`)

  const tools: Record<string, ToolDefinition> = {
    submit_finding: submitFindingTool(gibsonFindingsBackend(live), context),
    recall: recallTool(knowledge),
    gibson_componentize: componentizeTool(),
    gibson_enroll_component: enrollComponentTool(live),
    ...gibson.tools,
    ...delegationTools(live),
  }

  const injectKnowledge = ambientKnowledge(
    knowledge,
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
