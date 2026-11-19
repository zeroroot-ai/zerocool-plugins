#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * zerocool-agent — run zerocool headless as a daemon-driven `kind=agent`.
 *
 * The sibling of `zerocool-serve`, and the other half of dispatched mode. Where
 * `zerocool-serve` registers a TOOL — one named capability with declared
 * parameters — this registers an AGENT: a goal-driven executor. A mission node
 * hands over a Task. See {@link agentHandler}: it runs the opencode child on
 * the task grant of the work item, as a sandboxed dispatch does.
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
  decodeGrantClaims,
  GRANT_RENEW_BEFORE_MS,
  normalizePlatformURL,
  registerInstance,
  startAgentWorker,
  startHeartbeat,
  type AgentInvocation,
  type AgentOutcome,
} from "@zeroroot-ai/sdk"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { runOpencodeTask, type DispatchDeps } from "./dispatch.js"

/** Version reported to the daemon on registration. */
const VERSION = "0.1.0"

/**
 * The endpoint that the child dials for the harness callbacks: the daemon
 * endpoint that this worker polls. The Edge serves ComponentService and
 * HarnessCallbackService on one host. A sandboxed run dials the advertised
 * address of the same Edge. The expression is the one `connectGibson` uses for
 * the base URL of its transport.
 */
export function callbackEndpointOf(env: NodeJS.ProcessEnv): string {
  const raw = env.GIBSON_DAEMON_URL || env.GIBSON_PLATFORM_URL
  if (!raw) throw new Error("GIBSON_PLATFORM_URL is required")
  return normalizePlatformURL(raw)
}

/** What the handler needs from the worker process. */
export interface AgentHandlerOptions {
  /** The callback endpoint the child dials. See {@link callbackEndpointOf}. */
  callbackEndpoint: string
  /** opencode edits files here. Defaults to `ZEROCOOL_WORKSPACE` or the current directory. */
  workspace?: string
  /** Overridable opencode driver and event tap, for a test. */
  deps?: Pick<DispatchDeps, "run" | "onEvent">
}

/**
 * Make the handler of a polled work item.
 *
 * The handler runs the opencode child as a sandboxed dispatch does, through
 * `runOpencodeTask`. The child gets the task grant of the work item and the
 * callback endpoint in its environment, and in no other place. It then opens a
 * task harness with `openTaskHarness`: it resolves the model slot through the
 * Model gateway and reads knowledge with the task grant. The child gets no
 * direct provider key, because `opencodeChildEnv` drops them when a grant is
 * present. The child renews the grant itself, as in a sandboxed run, so the
 * grant that the handler reads at the start is enough.
 *
 * The handler never logs the grant. A work item with no grant fails here, in
 * `item.harness.token()`, before any child starts. A grant that has less than
 * one renewal window left after `token()` also fails before any child starts.
 */
export function agentHandler(options: AgentHandlerOptions): (item: AgentInvocation) => Promise<AgentOutcome> {
  return async (item) => {
    if (!item.goal.trim()) {
      // A dispatch with no goal is a defect upstream, not something to guess at.
      // Failing loudly beats running opencode against an empty prompt and
      // reporting whatever it says back as a mission result.
      throw new Error(`work ${item.workId} carried no task goal`)
    }
    const token = await item.harness.token()
    // `token()` renews a grant that is within the renewal window of its expiry.
    // A grant still inside that window after `token()` means the renewal failed.
    // The child starts with one grant and renews it itself, so it would start on
    // a grant that is about to end. Refuse, and fail the work item with a reason.
    const expiresAt = item.harness.expiresAt()
    if (expiresAt > 0 && expiresAt - Date.now() < GRANT_RENEW_BEFORE_MS) {
      throw new Error(
        `work ${item.workId}: the task grant ends in less than ${GRANT_RENEW_BEFORE_MS / 1000} seconds and the renewal did not extend it, so no child starts`,
      )
    }
    const missionRunId = item.task.run.missionRunId || decodeGrantClaims(token).missionRunId
    return await runOpencodeTask(
      {
        goal: item.goal,
        workspace: options.workspace ?? process.env.ZEROCOOL_WORKSPACE ?? process.cwd(),
        timeoutMs: item.timeoutMs,
        // Continuity across dispatches: opencode's own session id carries the
        // conversation. The result returns it in `opencode_session_id`, and a
        // later dispatch passes it back in the context of the work item.
        ...(item.context.opencode_session_id ? { sessionId: item.context.opencode_session_id } : {}),
        // The grant may be renewed during the run. Remove that value too.
        knownGrants: async () => [await item.harness.token()],
        grant: {
          callbackEndpoint: options.callbackEndpoint,
          callbackToken: token,
          missionRunId,
          agentRunId: item.task.run.agentRunId,
          traceId: item.task.run.traceId,
        },
      },
      options.deps,
    )
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

  const stop = startAgentWorker(session.clients.component, ref, {
    renewGrant: daemonGrantRenewer(session.transport),
    onWork: (item: AgentInvocation) =>
      console.error(
        `[zerocool-agent] claimed work ${item.workId} run=${item.task.run.agentRunId || "-"} ` +
          `timeout=${item.timeoutMs}ms goal=${JSON.stringify(item.goal.slice(0, 120))}`,
      ),
    onError: (e: unknown) => console.error(`[zerocool-agent] ${(e as Error).message}`),
    handler: agentHandler({ callbackEndpoint: callbackEndpointOf(process.env) }),
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
