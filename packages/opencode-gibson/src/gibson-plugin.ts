// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Hooks } from "@opencode-ai/plugin"
import { connectGibson, type GibsonSession } from "@zeroroot-ai/sdk"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ambientKnowledge } from "./knowledge.js"
import { openTaskRun, selectKnowledgeSource, type KnowledgeSourceDeps, type SelectedKnowledge } from "./knowledge-source.js"
import { gibsonMcpServer } from "./mcp-config.js"
import { modelSelector, modelSlot, PROVIDER_ID, resolveProvider } from "./model-provider.js"
import type { SessionContext } from "./findings.js"

/** The two calls that reach the platform. A test replaces them. */
export interface PluginDeps {
  connect: typeof connectGibson
  selectKnowledge: typeof selectKnowledgeSource
  /** Opens the task harness of a granted run. Defaults to `openTaskHarness`. */
  openHarness?: KnowledgeSourceDeps["openHarness"]
}

const defaultDeps: PluginDeps = { connect: connectGibson, selectKnowledge: selectKnowledgeSource }

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
 *   - in a dispatched run, resolves a model slot with `resolveModel` and
 *     registers a `gibson` provider that sends Open Responses calls to the
 *     Model gateway, with the task grant and the route headers of the reply,
 *   - reads the tenant knowledge graph and injects an ambient block (#8).
 *
 * THE TOOLS ARE NOT HERE. Every Gibson tool — findings, knowledge, delegation,
 * componentize, and one per RPC of every SDK service — comes from the Gibson
 * MCP server, which this plugin registers in opencode's own `mcp` block
 * (ADR-0158). opencode spawns it, so the tools reach the model the same way
 * they reach Claude Code, Cursor and the rest, and a new SDK release adds
 * tools with no change here.
 *
 * What is left is what only a plugin can do: the model provider, the ambient
 * knowledge injection, and the session id.
 *
 * The plugin fails open throughout. A coding agent that cannot reach its
 * platform must still be a working coding agent, so every platform failure
 * degrades to the standalone behaviour instead of refusing to start.
 */
export async function createGibsonPlugin(deps: PluginDeps = defaultDeps, env: NodeJS.ProcessEnv = process.env): Promise<Hooks> {
  // A run with a task grant is a dispatched run. The grant and the callback
  // endpoint are its whole credential, so it opens the task harness from them
  // before and without any component check-in. It needs no platform URL, no
  // host key and no bootstrap token, and a sandboxed run has none of them.
  if (env.GIBSON_CALLBACK_TOKEN || env.GIBSON_CALLBACK_ENDPOINT) {
    return await grantedPlugin(deps, env)
  }
  const platformURL = process.env.GIBSON_PLATFORM_URL
  const hostKeyPath = process.env.GIBSON_HOST_KEY_PATH ?? join(homedir(), ".zerocool", "host.key")
  const context: SessionContext = {}

  // Check in once, then run unattended — the platform's enrollment model
  // (ADR-0045). A human runs `gibson login` and `gibson agent enroll` once and
  // hands over the resulting ONE-TIME bootstrap token. That token completes the
  // first Capability Grant handshake and the host key it registers is persisted
  // at `hostKeyPath`. Every later start re-registers by proving possession of
  // that host key — the daemon routes on credential type: `host+jwt` is
  // re-registration, anything else is first registration.
  //
  // So the bootstrap token is passed ONLY when no host key exists yet. Replaying
  // a one-time token on every start would be rejected, and it would mean asking
  // the operator to keep a spent credential in their environment forever.
  const checkedIn = existsSync(hostKeyPath)
  const bootstrapToken = checkedIn ? undefined : process.env.GIBSON_BOOTSTRAP_TOKEN

  // Standalone: the MCP server still runs. It decides its own posture from
  // what is present, reports it through gibson_status, and offers the tools
  // that need no platform. A coding agent that cannot reach Gibson is still a
  // working coding agent.
  const standalone = (): Hooks => ({ config: async (config) => addMcpServer(config) })

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
    return standalone()
  }

  // The catalog holds an agent named "zerocool". A token-enrolled host checks in
  // under its own name, so the default differs from every catalog name.
  const agentName = process.env.GIBSON_AGENT_NAME ?? "zerocool-opencode"
  let session: GibsonSession | undefined
  try {
    session = await deps.connect({
      platformURL,
      daemonURL: process.env.GIBSON_DAEMON_URL,
      bootstrapToken,
      hostKeyPath,
      agentName,
      agentMode: process.env.GIBSON_AGENT_MODE ?? "autonomous",
      agent: { name: agentName, version: "0.0.0", capabilities: ["code"] },
    })
    console.error(
      `[zerocool] Gibson connected via ${checkedIn ? "the registered host key" : "first check-in"} ` +
        `(component_scope=${session.componentScope})`,
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
    return standalone()
  }

  const live = session

  // An interactive run reads the knowledge graph with the component grant.
  // It has no task, so it has no task grant and no model provider: opencode
  // uses the provider that the user configured.
  const selected = deps.selectKnowledge(live)
  console.error(`[zerocool] knowledge reads use the ${selected.scope} grant`)
  console.error(`[zerocool] no ${PROVIDER_ID} model provider: this run has no task grant`)
  return buildHooks({
    knowledge: selected,
    context,
    stop: () => {
      selected.stop()
      live.stop()
    },
  })
}

/**
 * The plugin of a granted run. It opens the task harness from the
 * `GIBSON_CALLBACK_*` variables, resolves the model slot on it, and locks
 * opencode to the `gibson` provider. It does not check in as a component: the
 * task harness gives the model path and the knowledge reads, and the Gibson MCP
 * server of the child joins the run with the same grant.
 *
 * The slot must resolve. When it does not, this throws and the run fails. The
 * driver also selects `gibson/<slot>` with `--model`, so a plugin that opencode
 * fails to load still ends in a failed run, not in a run on a direct provider.
 */
async function grantedPlugin(deps: PluginDeps, env: NodeJS.ProcessEnv): Promise<Hooks> {
  const run = openTaskRun(env, deps.openHarness ? { openHarness: deps.openHarness } : {})
  const slot = modelSlot(env)
  let provider: Record<string, unknown>
  try {
    provider = await resolveProvider(run.harness, slot)
  } catch (e) {
    run.stop()
    throw new Error(`the Model gateway did not resolve slot "${slot}": ${(e as Error).message}`, { cause: e })
  }
  console.error(`[zerocool] knowledge reads use the task grant`)
  console.error(`[zerocool] provider "${PROVIDER_ID}" sends Open Responses calls to the Model gateway for slot "${slot}"`)
  return buildHooks({
    knowledge: run,
    context: {},
    stop: () => run.stop(),
    grantedConfig: (config) => lockToGateway(config, provider, modelSelector(env)),
  })
}

/** Select the `gibson` provider and its model. The provider replaces any entry of the same name. */
export function lockToGateway(config: unknown, provider: Record<string, unknown>, selector: string): void {
  const cfg = config as { provider?: Record<string, unknown>; model?: string; small_model?: string }
  cfg.provider = cfg.provider ?? {}
  cfg.provider[PROVIDER_ID] = provider
  cfg.model = selector
  cfg.small_model = selector
}

interface HookInputs {
  knowledge: SelectedKnowledge
  context: SessionContext
  stop: () => void
  /** Set for a granted run: it locks the config to the gateway provider. */
  grantedConfig?: (config: unknown) => void
}

function buildHooks(inputs: HookInputs): Hooks {
  const { knowledge, context, stop } = inputs
  const injectKnowledge = ambientKnowledge(
    knowledge.knowledge,
    process.env.ZEROCOOL_AMBIENT_QUERY ?? "prior findings and security facts for this codebase",
  )

  return {
    // The Model gateway provider and the one tool surface: inject both at
    // config-load time (#6, ADR-0158). `Plugin` returns `Promise<Hooks>`, so
    // opencode cannot reach this hook before the slot has resolved.
    config: async (config) => {
      inputs.grantedConfig?.(config)
      addMcpServer(config)
    },

    // Ambient knowledge (#8): one cached GraphRAG lookup per session, injected
    // into the system prompt from the second turn on.
    "experimental.chat.system.transform": injectKnowledge,

    // Track the session id, which the ambient block and any local state key
    // off. This hook emits nothing: a file edit is not a security finding, and
    // inventing one would fill the tenant graph with noise a human must triage.
    event: async ({ event }) => {
      const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
      if (sessionID) context.sessionID = sessionID
    },

    dispose: async () => {
      // A task-scoped source holds a grant-renewal timer. Leaving it running
      // would keep renewing a grant for a session that has ended.
      stop()
    },
  } satisfies Hooks
}

/** Register the Gibson MCP server in opencode's own `mcp` block. */
function addMcpServer(config: unknown): void {
  const cfg = config as { mcp?: Record<string, unknown> }
  cfg.mcp = cfg.mcp ?? {}
  if (!cfg.mcp.gibson) cfg.mcp.gibson = gibsonMcpServer()
}

