// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { connectGibson, startCompletionsShim, type GibsonSession, type RunningShim } from "@zeroroot-ai/sdk"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ambientKnowledge } from "./knowledge.js"
import { selectKnowledgeSource } from "./knowledge-source.js"
import { gibsonMcpServer } from "./mcp-config.js"
import type { SessionContext } from "./findings.js"

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
 *   - reads the tenant knowledge graph and injects an ambient block (#8).
 *
 * THE TOOLS ARE NOT HERE. Every Gibson tool — findings, knowledge, delegation,
 * componentize, and one per RPC of every SDK service — comes from the Gibson
 * MCP server, which this plugin registers in opencode's own `mcp` block
 * (ADR-0008). opencode spawns it, so the tools reach the model the same way
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
    return standalone()
  }

  const shimUrl = shim.url
  const live = session

  // Which grant this process reads the knowledge graph with. A dispatched run
  // reads as the TASK; an interactive one keeps the component grant. Chosen once
  // here so nothing downstream has to ask.
  const { knowledge, scope: knowledgeScope, stop: stopKnowledge } = selectKnowledgeSource(live)
  console.error(`[zerocool] knowledge reads use the ${knowledgeScope} grant`)

  const injectKnowledge = ambientKnowledge(
    knowledge,
    process.env.ZEROCOOL_AMBIENT_QUERY ?? "prior findings and security facts for this codebase",
  )

  return {
    // Zero-config LLM, and the one tool surface: inject both at config-load
    // time (#6, ADR-0008).
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
      stopKnowledge()
      session?.stop()
      await shim?.close()
    },
  } satisfies Hooks
}

/** Register the Gibson MCP server in opencode's own `mcp` block. */
function addMcpServer(config: unknown): void {
  const cfg = config as { mcp?: Record<string, unknown> }
  cfg.mcp = cfg.mcp ?? {}
  if (!cfg.mcp.gibson) cfg.mcp.gibson = gibsonMcpServer()
}

export default GibsonPlugin
