#!/usr/bin/env node
/**
 * zerocool-serve — run zerocool headless as a dispatched fleet component.
 *
 * The inverse of the opencode plugin: instead of a human driving the agent, the
 * daemon drives it. The process checks in with the Capability Grant handshake,
 * registers as a TOOL, and then blocks on PollWork until a mission node sends
 * it something to do.
 *
 * WHY kind=tool AND NOT kind=agent. The harness enqueues remote work for `tool`
 * and `plugin` only; an agent mission node resolves against the daemon's
 * in-process agent registry and never reaches the work queue, so a component
 * registered as kind=agent would poll forever against an empty stream
 * (gibson#1195). Serving tool work is what makes a mission node actually run
 * out-of-cluster code today.
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
  registerComponentAs,
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
  // identity the harness dispatches to.
  const registered = await registerComponentAs(session.clients.component, "tool", {
    name: toolName,
    version: "0.1.0",
    capabilities: ["http_probe"],
    metadata: { served_by: "zerocool" },
  })

  // Heartbeat the TOOL identity, not just the session's agent identity. The
  // daemon expires an instance that stops heartbeating and PollWork then answers
  // NotFound forever — a process that looks healthy while being invisible to the
  // fleet.
  const toolReg = {
    name: toolName,
    version: "0.1.0",
    capabilities: ["http_probe"],
    metadata: { served_by: "zerocool" },
  }
  const stopHeartbeat = startHeartbeat(session.clients.component, toolReg, registered, (e: unknown) =>
    console.error(`[zerocool-serve] heartbeat: ${(e as Error).message}`),
  )

  console.error(
    `[zerocool-serve] registered tool "${toolName}" (instance=${registered.instanceId}); polling for work`,
  )

  const stop = startWorker(session.clients.component, {
    instanceId: registered.instanceId,
    reregister: async () => {
      const again = await registerComponentAs(session.clients.component, "tool", toolReg)
      console.error(`[zerocool-serve] re-registered (instance=${again.instanceId})`)
      return again.instanceId
    },
    onWork: (item: ToolInvocation) =>
      console.error(
        `[zerocool-serve] claimed work ${item.workId} (${item.workType}) input=${JSON.stringify(item.input)}`,
      ),
    onError: (e: unknown) => console.error(`[zerocool-serve] ${(e as Error).message}`),
    handler: async (item) => {
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
