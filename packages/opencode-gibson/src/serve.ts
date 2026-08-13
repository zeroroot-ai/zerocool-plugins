#!/usr/bin/env node
/**
 * zerocool-serve — run zerocool headless as a dispatched fleet component.
 *
 * The inverse of the opencode plugin: instead of a human driving the agent, the
 * daemon drives it. The process checks in with the Capability Grant handshake,
 * registers as a TOOL, and then blocks on PollWork until a mission node sends
 * it something to do.
 *
 * WHY kind=tool. Every kind receives dispatched work now — agent nodes included
 * (gibson#1197 / ADR-0011) — so this is a choice, not a limitation. A tool is
 * the honest description of what this process offers: one named capability with
 * declared parameters, invoked by whoever needs it. Registering as an agent
 * would promise a goal-driven executor with its own reasoning loop, which is
 * what the opencode plugin does interactively, not what this server does.
 *
 * Usage (after `gibson agent enroll --kind tool --name <name>`):
 *
 *   GIBSON_PLATFORM_URL=https://api.example:30443 \
 *   GIBSON_BOOTSTRAP_TOKEN=<one-time token> \
 *   ZEROCOOL_TOOL_NAME=zerocool-http \
 *     node dist/serve.js
 *
 * The token is needed for the first check-in only; afterwards the persisted
 * host key re-registers this host without human involvement (ADR-0045).
 */
import {
  connectGibson,
  registerInstance,
  startHeartbeat,
  startWorker,
  type ToolInvocation,
} from "@zerocool/sdk"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { httpProbeHandler } from "./http-probe.js"

async function main(): Promise<void> {
  const platformURL = process.env.GIBSON_PLATFORM_URL
  if (!platformURL) {
    console.error("[zerocool-serve] GIBSON_PLATFORM_URL is required")
    process.exit(2)
  }
  const toolName = process.env.ZEROCOOL_TOOL_NAME ?? "zerocool-http"
  const hostKeyPath = process.env.GIBSON_HOST_KEY_PATH ?? join(homedir(), ".zerocool", "host.key")
  const checkedIn = existsSync(hostKeyPath)

  const session = await connectGibson({
    platformURL,
    daemonURL: process.env.GIBSON_DAEMON_URL,
    // One-time token on first check-in only; the host key carries every later start.
    bootstrapToken: checkedIn ? undefined : process.env.GIBSON_BOOTSTRAP_TOKEN,
    hostKeyPath,
    agentName: toolName,
    agentMode: "dispatched",
    agent: { name: toolName, version: "0.1.0", capabilities: ["http_probe"] },
  })

  // Register under the kind that actually receives work. connectGibson has
  // already registered an agent identity for the session; this adds the tool
  // identity the harness dispatches to. registerInstance returns the ONE
  // shared InstanceRef the heartbeat and the work loop both use — renewal is
  // single-flight inside the ref, so an expired instance is re-registered
  // once and both loops adopt the new id (sdk-ts#6).
  const ref = await registerInstance(session.clients.component, "tool", {
    name: toolName,
    version: "0.1.0",
    capabilities: ["http_probe"],
    metadata: { served_by: "zerocool" },
  })

  // Heartbeat the TOOL identity, not just the session's agent identity. The
  // daemon expires an instance that stops heartbeating and PollWork then answers
  // NotFound forever — a process that looks healthy while being invisible to the
  // fleet.
  const stopHeartbeat = startHeartbeat(session.clients.component, ref, (e: unknown) =>
    console.error(`[zerocool-serve] heartbeat: ${(e as Error).message}`),
  )

  console.error(
    `[zerocool-serve] registered tool "${toolName}" (instance=${ref.current()}); polling for work`,
  )

  const stop = startWorker(session.clients.component, ref, {
    onWork: (item: ToolInvocation) =>
      console.error(
        `[zerocool-serve] claimed work ${item.workId} (${item.workType}) input=${JSON.stringify(item.input)}`,
      ),
    onError: (e: unknown) => console.error(`[zerocool-serve] ${(e as Error).message}`),
    handler: async (item: ToolInvocation) => {
      const result = await httpProbeHandler(item)
      console.error(
        `[zerocool-serve] ${result.url} -> ${result.status} ${result.statusText}, ` +
          `server=${result.server ?? "-"}, ${result.bytes} bytes in ${result.elapsedMs}ms`,
      )
      return result
    },
  })

  const shutdown = (): void => {
    console.error("[zerocool-serve] stopping")
    stop()
    stopHeartbeat()
    session.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((e: unknown) => {
  console.error(`[zerocool-serve] fatal: ${(e as Error).message}`)
  process.exit(1)
})
