// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { Code, ConnectError } from "@connectrpc/connect"
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
 * The session-context store: the three RPCs this plugin speaks, and how it
 * gets a credential to speak them with.
 *
 * The store is `PutSessionContext` / `GetSessionContext` /
 * `DeleteSessionContext` on `HarnessCallbackService`. The daemon keys one
 * opaque blob per (tenant, session_id) in the per-tenant dataplane store and
 * never reads the bytes. The tenant half comes from the caller's identity, so
 * no request names a tenant and one component cannot reach another's session
 * (gibson `internal/engine/harness/callback_session_context.go`).
 *
 * This is the TRUSTED home for a session's local context. Nothing here writes
 * a byte to the workspace or to the Devbox, which is the third acceptance
 * criterion of zerocool-plugins#11: the untrusted volume never sees it.
 */

/** The harness client. Only the three session RPCs are ever called on it. */
export type HarnessClient = GibsonClients["harness"]

/**
 * The server's blob cap, mirrored here so an oversized snapshot is trimmed
 * before it is shipped instead of refused on arrival (gibson
 * `callback_session_context.go`, `maxSessionContextBytes`).
 */
export const MAX_CONTEXT_BYTES = 8 << 20

/** The daemon's bound on the storage key (`maxSessionIDBytes`). */
export const MAX_SESSION_ID_BYTES = 256

/** What one read of the store returned. A fresh session reads back empty. */
export interface StoredContext {
  data: Uint8Array
  /** The version this read saw. `""` when no blob exists yet. */
  etag: string
}

/** The store, as this plugin uses it. */
export interface SessionContextStore {
  get(sessionId: string): Promise<StoredContext>
  /** Returns the etag of the version the write produced. */
  put(sessionId: string, data: Uint8Array, ifMatch: string): Promise<string>
}

/** Wrap a harness client as the store. */
export function sessionContextStore(client: HarnessClient): SessionContextStore {
  return {
    async get(sessionId) {
      const res = await client.getSessionContext({ sessionId })
      return { data: res.data, etag: res.etag }
    },
    async put(sessionId, data, ifMatch) {
      const res = await client.putSessionContext({ sessionId, data, ifMatch })
      return res.etag
    },
  }
}

/** A stale write lost the etag race. Read the current version and try again. */
export function isConflict(e: unknown): boolean {
  return ConnectError.from(e).code === Code.Aborted
}

/**
 * The store is not there: this daemon wired no session-context store
 * (`Unavailable`), or the surface does not exist on the endpoint this plugin
 * reached (`Unimplemented`). Neither is transient, so the mirror stops rather
 * than retrying a call that will never work.
 */
export function isStoreAbsent(e: unknown): boolean {
  const code = ConnectError.from(e).code
  return code === Code.Unavailable || code === Code.Unimplemented
}

/** Which credential the mirror writes with, and how to release it. */
export interface SelectedStore {
  store?: SessionContextStore
  /** `standalone` mirrors nothing: opencode keeps its local disk, untouched. */
  mode: "task" | "component" | "standalone"
  /** Why the mode is `standalone`. Empty in the other two modes. */
  reason: string
  stop: () => void
}

/** Seams, so a test can choose the mode without a daemon. */
export interface StoreSelectionDeps {
  env?: NodeJS.ProcessEnv
  /** Defaults to `openTaskHarness` on the dispatch grant. */
  openHarness?: (opts: OpenTaskHarnessOptions) => TaskHarness
  /** Defaults to the Capability Grant handshake against the platform URL. */
  openComponent?: (opts: ComponentStoreOptions) => Promise<HarnessClient>
  /** Defaults to `node:fs.existsSync`. */
  hostKeyExists?: (path: string) => boolean
}

/** What the component-grant path needs to reach the daemon. */
export interface ComponentStoreOptions {
  platformURL: string
  daemonURL?: string
  hostKeyPath: string
  agentName: string
}

/**
 * Open a harness client on the host key this process already registered.
 *
 * This is the Capability Grant handshake and NOTHING else: no
 * `RegisterComponent` and no heartbeat. The mirror needs a credential, not a
 * second fleet identity — the main plugin already registered this process as
 * one agent instance, and registering again would double-count the host and
 * run a second heartbeat for the same opencode.
 *
 * It also never spends a bootstrap token. That token is one-time (ADR-0045),
 * and two plugins racing to spend it would leave one of them holding a
 * credential the daemon has already retired. So this path runs only when the
 * host key is on disk, which means the main plugin's first check-in is done.
 */
async function openComponentStore(opts: ComponentStoreOptions): Promise<HarnessClient> {
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

/**
 * Pick the credential this process mirrors with.
 *
 * A DISPATCHED run writes as the TASK. gibson mints a per-dispatch grant and
 * the driver passes it down as GIBSON_CALLBACK_ENDPOINT / GIBSON_CALLBACK_TOKEN,
 * the same child contract `selectKnowledgeSource` reads in the main plugin. The
 * dispatched grant wins when both are present, which is the priority CONTEXT.md
 * records for every check-in source.
 *
 * An INTERACTIVE run writes as the component, on the host key the main plugin
 * registered.
 *
 * Anything else is STANDALONE: the plugin mirrors nothing and opencode keeps
 * its local disk. That is one code path chosen once, here, not a fallback
 * taken later on a failed call.
 */
export async function selectSessionStore(deps: StoreSelectionDeps = {}): Promise<SelectedStore> {
  const env = deps.env ?? process.env
  const standalone = (reason: string): SelectedStore => ({ mode: "standalone", reason, stop: () => {} })

  const endpoint = env.GIBSON_CALLBACK_ENDPOINT
  const token = env.GIBSON_CALLBACK_TOKEN
  if (endpoint && token) {
    const harness = (deps.openHarness ?? openTaskHarness)({
      endpoint,
      token,
      insecure: env.GIBSON_CALLBACK_INSECURE === "1",
    })
    return { store: sessionContextStore(harness.client), mode: "task", reason: "", stop: () => harness.stop() }
  }
  if (endpoint) {
    // The same rule the knowledge source keeps: a dispatch that carries an
    // endpoint but no token must not quietly write as the component instead.
    return standalone(
      "GIBSON_CALLBACK_ENDPOINT is set but GIBSON_CALLBACK_TOKEN is not; " +
        "mirroring as the component would widen this run's authority",
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

  const client = await (deps.openComponent ?? openComponentStore)({
    platformURL,
    daemonURL: env.GIBSON_DAEMON_URL,
    hostKeyPath,
    agentName: env.GIBSON_AGENT_NAME ?? "zerocool",
  })
  return { store: sessionContextStore(client), mode: "component", reason: "", stop: () => {} }
}

/** The host key the main plugin writes, under the same default. */
export function defaultHostKeyPath(): string {
  return join(homedir(), ".zerocool", "host.key")
}
