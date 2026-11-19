#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * zerocool-agent — run zerocool headless as a daemon-driven `kind=agent`.
 *
 * The sibling of `zerocool-serve`, and the other half of dispatched mode. Where
 * `zerocool-serve` registers a TOOL — one named capability with declared
 * parameters — this registers an AGENT: a goal-driven executor. A mission node
 * hands over a Task. See {@link agentHandler}: until the SDK gives a polled
 * work item its task grant, this process answers each Task with a failed A2A
 * Task and starts no opencode child.
 *
 * This is zerocool-plugins#33, Option B, per the owner decision of 2026-08-15.
 * It does not reopen ADR-0155: the driver is a bin in this package, not a fork
 * of opencode, which is exactly the carve-out ADR-0155 wrote. See
 * ADR-0156.
 *
 * Usage (after `gibson agent enroll --kind agent --name zerocool-opencode`):
 *
 *   GIBSON_PLATFORM_URL=https://api.example:30443 \
 *   GIBSON_BOOTSTRAP_TOKEN=<one-time token> \
 *   ZEROCOOL_AGENT_NAME=zerocool-opencode \
 *     zerocool-agent
 *
 * The token is needed for the first check-in only; afterwards the persisted host
 * key re-registers this host without human involvement (ADR-0045).
 */
import {
  connectGibson,
  daemonGrantRenewer,
  registerInstance,
  startAgentWorker,
  startHeartbeat,
  TaskState,
  type AgentInvocation,
  type AgentOutcome,
} from "@zeroroot-ai/sdk"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Version reported to the daemon on registration. */
const VERSION = "0.1.0"

/** The error code of a work item that this agent cannot serve. */
export const NO_GATEWAY_PATH = "NO_MODEL_GATEWAY_PATH"

/**
 * Answer one dispatched Task with a failed A2A Task.
 *
 * THIS AGENT CANNOT RUN OPENCODE FOR A POLLED WORK ITEM YET. The opencode child
 * has to reach the Model gateway on the task grant of the work item, and the
 * SDK does not hand that grant to the handler. `AgentInvocation` has the
 * `harness` calls, `resolveModel` and `model`, and the grant stays inside the
 * SDK. A polled work item also has no callback endpoint, so the child cannot
 * open a task harness of its own.
 *
 * The child would otherwise start with no gateway provider. It would run on a
 * direct provider key from its environment, which is a silent fallback. So the
 * handler fails the work item with a reason and starts no child. No child also
 * means no knowledge read with the component grant instead of the task grant.
 *
 * THE SDK CHANGE THAT ENDS THIS: `AgentInvocation` must expose the current task
 * grant (a function that returns the renewed token) and the callback endpoint
 * of the daemon, as `TaskHarness` does with `token()` and `endpoint`. The
 * worker can then hand both to the child as `GIBSON_CALLBACK_TOKEN` and
 * `GIBSON_CALLBACK_ENDPOINT`, and the plugin of the child resolves the slot.
 *
 * Exported for tests.
 */
export async function agentHandler(item: AgentInvocation): Promise<AgentOutcome> {
  const message =
    `work ${item.workId}: this agent cannot start opencode for a polled work item. ` +
    "The SDK does not give the handler the task grant that the Model gateway needs. " +
    "A direct provider key is not a substitute."
  return {
    state: TaskState.TASK_STATE_FAILED,
    output: message,
    error: { code: NO_GATEWAY_PATH, message, retryable: false },
    metadata: { error: message },
  }
}

async function main(): Promise<void> {
  const platformURL = process.env.GIBSON_PLATFORM_URL
  if (!platformURL) {
    console.error("[zerocool-agent] GIBSON_PLATFORM_URL is required")
    process.exit(2)
  }
  const agentName = process.env.ZEROCOOL_AGENT_NAME ?? "zerocool-opencode"
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
    metadata: { served_by: "zerocool" },
  })

  const stopHeartbeat = startHeartbeat(session.clients.component, ref, (e: unknown) =>
    console.error(`[zerocool-agent] heartbeat: ${(e as Error).message}`),
  )

  console.error(
    `[zerocool-agent] registered agent "${agentName}" (instance=${ref.current()}) ` +
      "polling for work",
  )
  console.error(`[zerocool-agent] warning: ${NO_GATEWAY_PATH}: every work item fails until the SDK gives the handler the task grant`)

  const stop = startAgentWorker(session.clients.component, ref, {
    renewGrant: daemonGrantRenewer(session.transport),
    onWork: (item: AgentInvocation) =>
      console.error(
        `[zerocool-agent] claimed work ${item.workId} run=${item.task.run.agentRunId || "-"} ` +
          `timeout=${item.timeoutMs}ms goal=${JSON.stringify(item.goal.slice(0, 120))}`,
      ),
    onError: (e: unknown) => console.error(`[zerocool-agent] ${(e as Error).message}`),
    handler: agentHandler,
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
if (process.argv[1]?.endsWith("serve-agent.js")) {
  main().catch((e: unknown) => {
    console.error(`[zerocool-agent] fatal: ${(e as Error).message}`)
    process.exit(1)
  })
}
