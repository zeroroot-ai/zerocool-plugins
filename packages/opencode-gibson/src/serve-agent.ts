#!/usr/bin/env node
/**
 * zerocool-agent — run zerocool headless as a daemon-driven `kind=agent`.
 *
 * The sibling of `zerocool-serve`, and the other half of dispatched mode. Where
 * `zerocool-serve` registers a TOOL — one named capability with declared
 * parameters — this registers an AGENT: a goal-driven executor. A mission node
 * hands over a Task, and this process pursues it by driving opencode headless
 * for as long as the dispatch allows.
 *
 * This is zerocool-plugins#33, Option B, per the owner decision of 2026-08-15.
 * It does not reopen ADR-0005: the driver is a bin in this package, not a fork
 * of opencode, which is exactly the carve-out ADR-0005 wrote. See
 * `docs/adr/0006-kind-agent-dispatched-shape.md`.
 *
 * Usage (after `gibson agent enroll --kind agent --name zerocool`):
 *
 *   GIBSON_PLATFORM_URL=https://api.example:30443 \
 *   GIBSON_BOOTSTRAP_TOKEN=<one-time token> \
 *   ZEROCOOL_AGENT_NAME=zerocool \
 *   ZEROCOOL_WORKSPACE=/srv/work \
 *     zerocool-agent
 *
 * The token is needed for the first check-in only; afterwards the persisted host
 * key re-registers this host without human involvement (ADR-0045).
 */
import {
  connectGibson,
  registerInstance,
  startAgentWorker,
  startHeartbeat,
  type AgentInvocation,
  type AgentOutcome,
} from "@zeroroot-ai/sdk"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { runOpencode } from "./opencode-run.js"

/** Version reported to the daemon on registration. */
const VERSION = "0.1.0"

/**
 * Turn one dispatched Task into one headless opencode run.
 *
 * Exported for tests: the loop around it is `startAgentWorker`'s, and the value
 * of this function is entirely in what it maps onto and off the wire.
 */
export async function agentHandler(
  item: AgentInvocation,
  opts: { workspace: string; model?: string },
): Promise<AgentOutcome> {
  if (!item.goal.trim()) {
    // A dispatch with no goal is a defect upstream, not something to guess at.
    // Failing loudly beats running opencode against an empty prompt and
    // reporting whatever it says back as a mission result.
    throw new Error(`work ${item.workId} carried no task goal`)
  }

  const run = await runOpencode({
    goal: item.goal,
    dir: opts.workspace,
    model: opts.model,
    // Continuity across dispatches: the daemon's agent_run_id is stable for a
    // retried node, but opencode's own session id is what carries the
    // conversation. It is returned in metadata below so a follow-up dispatch can
    // pass it back — see the ADR on why this is not yet automatic.
    sessionId: item.context.opencode_session_id,
    timeoutMs: item.timeoutMs,
    env: {
      // The task-scoped callback seam. gibson mints these per dispatch
      // (`internal/engine/harness/implementation.go:1205-1210`) so a dispatched
      // run reaches the harness as the TASK rather than as this component.
      // Passed through to the child now; the plugin consuming them in
      // preference to the host-key grant is tracked in the ADR as the next
      // slice — today the child still authenticates as the component, which is
      // broader authority than the dispatch intends.
      ...(item.callbackEndpoint ? { GIBSON_CALLBACK_ENDPOINT: item.callbackEndpoint } : {}),
      ...(item.callbackToken ? { GIBSON_CALLBACK_TOKEN: item.callbackToken } : {}),
      // Provenance, so anything the child emits can be correlated to this run.
      ...(item.missionRunId ? { GIBSON_MISSION_RUN_ID: item.missionRunId } : {}),
      ...(item.agentRunId ? { GIBSON_AGENT_RUN_ID: item.agentRunId } : {}),
      ...(item.traceId ? { GIBSON_TRACE_ID: item.traceId } : {}),
    },
  })

  return {
    output: run.text,
    metadata: {
      opencode_session_id: run.sessionId,
      finish_reason: run.finishReason,
      tokens_total: String(run.tokens.total),
      tokens_output: String(run.tokens.output),
      cost: String(run.cost),
    },
  }
}

async function main(): Promise<void> {
  const platformURL = process.env.GIBSON_PLATFORM_URL
  if (!platformURL) {
    console.error("[zerocool-agent] GIBSON_PLATFORM_URL is required")
    process.exit(2)
  }
  const agentName = process.env.ZEROCOOL_AGENT_NAME ?? "zerocool"
  const workspace = process.env.ZEROCOOL_WORKSPACE ?? process.cwd()
  const model = process.env.ZEROCOOL_MODEL
  const hostKeyPath = process.env.GIBSON_HOST_KEY_PATH ?? join(homedir(), ".zerocool", "host.key")
  const checkedIn = existsSync(hostKeyPath)

  const session = await connectGibson({
    platformURL,
    daemonURL: process.env.GIBSON_DAEMON_URL,
    bootstrapToken: checkedIn ? undefined : process.env.GIBSON_BOOTSTRAP_TOKEN,
    hostKeyPath,
    agentName,
    agentMode: "dispatched",
    agent: { name: agentName, version: VERSION, capabilities: ["code"] },
  })

  // Register the AGENT identity the harness dispatches `agent_execute` to, and
  // hold the ONE shared InstanceRef the heartbeat and work loop both use —
  // renewal is single-flight inside the ref, so an expired instance is
  // re-registered once and both loops adopt the new id (sdk-ts#6).
  const ref = await registerInstance(session.clients.component, "agent", {
    name: agentName,
    version: VERSION,
    capabilities: ["code"],
    metadata: { served_by: "zerocool", workspace },
  })

  const stopHeartbeat = startHeartbeat(session.clients.component, ref, (e: unknown) =>
    console.error(`[zerocool-agent] heartbeat: ${(e as Error).message}`),
  )

  console.error(
    `[zerocool-agent] registered agent "${agentName}" (instance=${ref.current()}) ` +
      `workspace=${workspace}; polling for work`,
  )

  const stop = startAgentWorker(session.clients.component, ref, {
    onWork: (item: AgentInvocation) =>
      console.error(
        `[zerocool-agent] claimed work ${item.workId} run=${item.agentRunId || "-"} ` +
          `timeout=${item.timeoutMs}ms goal=${JSON.stringify(item.goal.slice(0, 120))}`,
      ),
    onError: (e: unknown) => console.error(`[zerocool-agent] ${(e as Error).message}`),
    handler: async (item: AgentInvocation) => {
      const outcome = await agentHandler(item, { workspace, model })
      console.error(
        `[zerocool-agent] finished ${item.workId} reason=${outcome.metadata?.finish_reason ?? "-"} ` +
          `tokens=${outcome.metadata?.tokens_total ?? "-"}`,
      )
      return outcome
    },
  })

  const shutdown = (): void => {
    console.error("[zerocool-agent] stopping")
    stop()
    stopHeartbeat()
    session.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

// Only run when executed as the bin, so the handler above stays importable.
if (process.argv[1] && /serve-agent\.js$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(`[zerocool-agent] fatal: ${(e as Error).message}`)
    process.exit(1)
  })
}
