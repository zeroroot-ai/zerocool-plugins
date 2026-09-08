// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"

import { startMirror } from "./mirror.js"
import type { SessionReader } from "./snapshot.js"
import { selectSessionStore, type StoreSelectionDeps } from "./store.js"

/**
 * `@zeroroot-ai/zerocool-sessions` — the store seam (zerocool-plugins#11).
 *
 * WHAT IT DOES. In Platform mode it mirrors opencode's session state to the
 * daemon session store on every `session.updated` and `message.updated`, so a
 * session survives a restart of the host rather than living only on one
 * laptop's disk. It restores on start when GIBSON_OPENCODE_SESSION_ID names an
 * earlier session, which is the same variable `zerocool-dispatch` passes to
 * continue one.
 *
 * WHAT IT DOES NOT DO. It never replaces opencode's storage. opencode owns the
 * session format and the local copy; this is a copy of it in the tenant's
 * trusted store, and a full replacement needs the fork, not a plugin. It also
 * never writes local context to the Devbox: the only RPCs it calls are
 * PutSessionContext and GetSessionContext, which the daemon keys by (tenant,
 * session_id) in the per-tenant dataplane store.
 *
 * MODES, chosen once at start (see `selectSessionStore`):
 *   - dispatched: the task grant on GIBSON_CALLBACK_ENDPOINT / _TOKEN,
 *   - interactive: the component grant on the host key the main plugin wrote,
 *   - standalone: no mirror at all, and opencode is unchanged.
 *
 * FAIL OPEN, like the main plugin. A store that is absent stops the mirror
 * after one warning. The session keeps running on opencode's own disk.
 *
 * INSTALL. It is opt-in, alongside `@zeroroot-ai/zerocool`:
 *
 *   { "plugin": ["@zeroroot-ai/zerocool", "@zeroroot-ai/zerocool-sessions"] }
 */
export const GibsonSessionsPlugin: Plugin = async (input) => {
  return sessionsPlugin(input)
}

/** Seams, so a test drives the plugin with no daemon and no timers. */
export interface SessionsPluginDeps extends StoreSelectionDeps {
  reader?: SessionReader
  /** Where every line this plugin writes goes. Defaults to stderr. */
  log?: (message: string) => void
  clock?: () => number
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">
}

/** The plugin body. `GibsonSessionsPlugin` is this with the real seams. */
export async function sessionsPlugin(input: PluginInput, deps: SessionsPluginDeps = {}): Promise<Hooks> {
  const env = deps.env ?? process.env
  const log = deps.log ?? ((m: string) => console.error(m))

  const selected = await selectSessionStore(deps)
  if (!selected.store) {
    // One code path, chosen here: standalone means opencode's local disk and
    // no hooks at all, which is exactly opencode's own behaviour.
    log(`[zerocool-sessions] mirroring off, ${selected.reason}; opencode keeps its local session storage`)
    return {}
  }

  const mirror = startMirror({
    store: selected.store,
    reader: deps.reader ?? opencodeReader(input),
    debounceMs: debounceMs(env),
    warn: log,
    clock: deps.clock,
    timers: deps.timers,
  })
  log(`[zerocool-sessions] mirroring opencode sessions to the daemon store on the ${selected.mode} grant`)

  // Restore: adopt the stored version for the session this process continues,
  // so the first checkpoint extends that chain instead of racing it as a
  // create. GIBSON_OPENCODE_SESSION_ID is the name `zerocool-dispatch` already
  // uses to continue an opencode session.
  const priorId = env.GIBSON_OPENCODE_SESSION_ID
  if (priorId) {
    const prior = await mirror.restore(priorId)
    if (prior) {
      log(
        `[zerocool-sessions] session ${priorId} found in the daemon store: ` +
          `${prior.messages.length} messages, written ${new Date(prior.writtenAt).toISOString()}` +
          (prior.dropped > 0 ? `, ${prior.dropped} older messages dropped by the size cap` : ""),
      )
    } else {
      log(`[zerocool-sessions] session ${priorId} has no blob in the daemon store yet`)
    }
  }

  return {
    // The hooks that fire when opencode's own state changes. `session.updated`
    // carries the session record and `message.updated` carries a message that
    // names its session, so the id comes off the event itself and this plugin
    // mints no second identity for a session opencode already named.
    event: async ({ event }) => {
      const sessionId = sessionIdOf(event)
      if (sessionId) mirror.touch(sessionId)
    },

    dispose: async () => {
      // The last checkpoint of the session. A debounce window that has not
      // elapsed when opencode exits would otherwise lose the final turn.
      await mirror.flush()
      mirror.stop()
      selected.stop()
    },
  } satisfies Hooks
}

/** The two events this plugin mirrors on, and the session each names. */
export function sessionIdOf(event: unknown): string | undefined {
  const e = event as { type?: string; properties?: { info?: { id?: string; sessionID?: string } } }
  if (e?.type === "session.updated") return e.properties?.info?.id
  if (e?.type === "message.updated") return e.properties?.info?.sessionID
  return undefined
}

/** How long to collapse events over. */
function debounceMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.ZEROCOOL_SESSION_MIRROR_DEBOUNCE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 2000
}

/** Read opencode's own session state, through opencode's own server. */
function opencodeReader(input: PluginInput): SessionReader {
  return {
    async read(sessionId) {
      const session = await input.client.session.get({ path: { id: sessionId } })
      const messages = await input.client.session.messages({ path: { id: sessionId } })
      return { session: session.data, messages: messages.data ?? [] }
    },
  }
}

export default GibsonSessionsPlugin
