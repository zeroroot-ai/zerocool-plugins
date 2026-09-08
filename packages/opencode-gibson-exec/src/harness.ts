// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { createGrpcTransport } from "@connectrpc/connect-node"
import {
  CapabilityGrantClient,
  createGibsonClients,
  normalizePlatformURL,
  openTaskHarness,
  type GibsonClients,
  type OpenTaskHarnessOptions,
  type TaskHarness,
} from "@zeroroot-ai/sdk"

/**
 * Which credential this plugin calls `HarnessCallbackService` with.
 *
 * A DISPATCHED run speaks as the TASK. gibson mints a per-dispatch grant and
 * the driver passes it down as GIBSON_CALLBACK_ENDPOINT / GIBSON_CALLBACK_TOKEN,
 * the same child contract `selectKnowledgeSource` reads in the main plugin. The
 * dispatched grant wins when both are present, which is the priority CONTEXT.md
 * records for every check-in source.
 *
 * An INTERACTIVE run speaks as the component, on the host key the main plugin
 * registered.
 *
 * Anything else is STANDALONE: this plugin contributes nothing and opencode
 * runs commands on the host, as it does with no platform. That is one mode
 * chosen once at start, not a fallback taken later on a failed call.
 *
 * `@zeroroot-ai/zerocool-sessions` makes the same choice for the same reasons
 * (`packages/opencode-gibson-sessions/src/store.ts`). The two copies are
 * deliberate and temporary: the durable home for this is `@zeroroot-ai/sdk`,
 * beside `openTaskHarness` and `connectGibson`, and a cross-package dependency
 * inside this workspace would put an unbuilt sibling in the type and run paths
 * of every check. CONTEXT.md records the follow-up.
 */

/** The harness client. Only `DevboxExec` is ever called on it. */
export type HarnessClient = GibsonClients["harness"]

/** The credential this process got, and how to release it. */
export interface SelectedHarness {
  client?: HarnessClient
  mode: "task" | "component" | "standalone"
  /** Why the mode is `standalone`. Empty in the other two modes. */
  reason: string
  stop: () => void
}

/** Seams, so a test chooses the mode with no daemon. */
export interface HarnessSelectionDeps {
  env?: NodeJS.ProcessEnv
  /** Defaults to `openTaskHarness` on the dispatch grant. */
  openHarness?: (opts: OpenTaskHarnessOptions) => TaskHarness
  /** Defaults to the Capability Grant handshake against the platform URL. */
  openComponent?: (opts: ComponentHarnessOptions) => Promise<HarnessClient>
  /** Defaults to `node:fs.existsSync`. */
  hostKeyExists?: (path: string) => boolean
}

/** What the component-grant path needs to reach the daemon. */
export interface ComponentHarnessOptions {
  platformURL: string
  daemonURL?: string
  hostKeyPath: string
  agentName: string
}

/**
 * Open a harness client on the host key this process already registered.
 *
 * This is the Capability Grant handshake and NOTHING else: no
 * `RegisterComponent` and no heartbeat. This plugin needs a credential, not a
 * second fleet identity — the main plugin already registered this process as
 * one agent instance, and registering again would double-count the host and
 * run a second heartbeat for the same opencode.
 *
 * It also never spends a bootstrap token. That token is one-time (ADR-0045),
 * and two plugins racing to spend it would leave one of them holding a
 * credential the daemon has already retired. So this path runs only when the
 * host key is on disk, which means the main plugin's first check-in is done.
 */
async function openComponentHarness(opts: ComponentHarnessOptions): Promise<HarnessClient> {
  const cg = new CapabilityGrantClient({
    platformURL: opts.platformURL,
    agentName: opts.agentName,
    hostKeyPath: opts.hostKeyPath,
  })
  await cg.register()
  const transport = createGrpcTransport({
    baseUrl: opts.daemonURL ? normalizePlatformURL(opts.daemonURL) : cg.platformURL,
    interceptors: [cg.authInterceptor()],
  })
  return createGibsonClients(transport).harness
}

/** Pick the credential this process runs Devbox commands with. */
export async function selectHarness(deps: HarnessSelectionDeps = {}): Promise<SelectedHarness> {
  const env = deps.env ?? process.env
  const standalone = (reason: string): SelectedHarness => ({ mode: "standalone", reason, stop: () => {} })

  const endpoint = env.GIBSON_CALLBACK_ENDPOINT
  const token = env.GIBSON_CALLBACK_TOKEN
  if (endpoint && token) {
    const harness = (deps.openHarness ?? openTaskHarness)({
      endpoint,
      token,
      insecure: env.GIBSON_CALLBACK_INSECURE === "1",
    })
    return { client: harness.client, mode: "task", reason: "", stop: () => harness.stop() }
  }
  if (endpoint) {
    // The same rule the knowledge source keeps: a dispatch that carries an
    // endpoint but no token must not quietly run as the component instead.
    return standalone(
      "GIBSON_CALLBACK_ENDPOINT is set but GIBSON_CALLBACK_TOKEN is not; " +
        "running as the component would widen this run's authority",
    )
  }

  const platformURL = env.GIBSON_PLATFORM_URL
  if (!platformURL) return standalone("GIBSON_PLATFORM_URL is not set")

  const hostKeyPath = env.GIBSON_HOST_KEY_PATH ?? defaultHostKeyPath()
  const exists = deps.hostKeyExists ?? existsSync
  if (!exists(hostKeyPath)) {
    return standalone(
      `this host has not checked in yet (no host key at ${hostKeyPath}); ` +
        "start the main zerocool plugin once with GIBSON_BOOTSTRAP_TOKEN",
    )
  }

  const client = await (deps.openComponent ?? openComponentHarness)({
    platformURL,
    daemonURL: env.GIBSON_DAEMON_URL,
    hostKeyPath,
    agentName: env.GIBSON_AGENT_NAME ?? "zerocool",
  })
  return { client, mode: "component", reason: "", stop: () => {} }
}

/** The host key the main plugin writes, under the same default. */
export function defaultHostKeyPath(): string {
  return join(homedir(), ".zerocool", "host.key")
}
