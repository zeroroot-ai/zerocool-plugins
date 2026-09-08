// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { buildSnapshot, decodeSnapshot, type SessionReader, type SessionSnapshot } from "./snapshot.js"
import { isConflict, isStoreAbsent, type SessionContextStore } from "./store.js"

/**
 * The mirror: opencode's session state, copied to the daemon store.
 *
 * THREE RULES, and they are the whole design.
 *
 * 1. DEBOUNCE. `session.updated` and `message.updated` fire per message and
 *    per streamed part. Writing on each one would put a multi-megabyte blob on
 *    the wire many times a second. A touch schedules one write; every touch
 *    inside the window collapses into it.
 *
 * 2. ETAG. Every write carries the etag of the version it is based on. An empty
 *    etag means "create". A write that lost the race comes back `Aborted`, and
 *    the mirror reads the current version and retries ONCE. A second failure is
 *    another writer winning repeatedly, which retrying harder cannot fix.
 *
 * 3. FAIL OPEN. A coding agent that cannot reach its platform must still be a
 *    working coding agent. A store that is absent stops the mirror after one
 *    warning; opencode's own disk carries the session, as it does standalone.
 *    Any other failure warns once and keeps trying, because a network blip must
 *    not cost the rest of the session its durable copy.
 */

export interface MirrorOptions {
  store: SessionContextStore
  reader: SessionReader
  /** Milliseconds to collapse events over. */
  debounceMs: number
  /** Called once per distinct failure class. */
  warn: (message: string) => void
  clock?: () => number
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">
}

export interface SessionMirror {
  /** Note that a session changed. Schedules one write. */
  touch(sessionId: string): void
  /**
   * Read a session's stored blob and adopt its etag, so the first write
   * continues that version chain instead of racing it as a create.
   */
  restore(sessionId: string): Promise<SessionSnapshot | undefined>
  /** Write every pending session now. Used by `dispose`. */
  flush(): Promise<void>
  /** Stop mirroring. Pending timers are cancelled, not run. */
  stop(): void
  /** False once the store proved absent. */
  active(): boolean
}

/** Per-session state the mirror carries between writes. */
interface Tracked {
  etag: string
  timer?: ReturnType<typeof setTimeout>
  /** A write is on the wire; touch again when it lands. */
  writing: boolean
  /** A touch arrived while a write was on the wire. */
  again: boolean
}

export function startMirror(opts: MirrorOptions): SessionMirror {
  const timers = opts.timers ?? globalThis
  const clock = opts.clock ?? Date.now
  const tracked = new Map<string, Tracked>()
  let running = true
  let warnedOther = false

  const state = (sessionId: string): Tracked => {
    let s = tracked.get(sessionId)
    if (!s) {
      s = { etag: "", writing: false, again: false }
      tracked.set(sessionId, s)
    }
    return s
  }

  const shutDown = (message: string): void => {
    running = false
    for (const s of tracked.values()) {
      if (s.timer) timers.clearTimeout(s.timer)
      s.timer = undefined
    }
    opts.warn(message)
  }

  /** One write, with the single etag retry. Never throws. */
  const write = async (sessionId: string): Promise<void> => {
    const s = state(sessionId)
    s.writing = true
    try {
      const { session, messages } = await opts.reader.read(sessionId)
      const { data } = buildSnapshot(sessionId, session, messages, clock())
      try {
        s.etag = await opts.store.put(sessionId, data, s.etag)
      } catch (e) {
        if (!isConflict(e)) throw e
        // Another writer holds the current version. Read it, then write once
        // more on top of it. Losing twice means a writer we cannot outrun.
        const current = await opts.store.get(sessionId)
        s.etag = await opts.store.put(sessionId, data, current.etag)
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      if (isStoreAbsent(e)) {
        shutDown(
          `[zerocool-sessions] the daemon session store is not available (${reason}); ` +
            "this session stays on opencode's local disk",
        )
      } else if (!warnedOther) {
        warnedOther = true
        opts.warn(`[zerocool-sessions] a checkpoint failed (${reason}); the mirror keeps trying`)
      }
    } finally {
      s.writing = false
      if (s.again && running) {
        s.again = false
        schedule(sessionId)
      }
    }
  }

  const schedule = (sessionId: string): void => {
    const s = state(sessionId)
    if (s.timer) timers.clearTimeout(s.timer)
    s.timer = timers.setTimeout(() => {
      s.timer = undefined
      void write(sessionId)
    }, opts.debounceMs)
    // A debounce timer must never be the last thing keeping opencode alive.
    ;(s.timer as { unref?: () => void }).unref?.()
  }

  return {
    touch(sessionId) {
      if (!running || !sessionId) return
      const s = state(sessionId)
      if (s.writing) {
        s.again = true
        return
      }
      schedule(sessionId)
    },

    async restore(sessionId) {
      if (!running || !sessionId) return undefined
      try {
        const current = await opts.store.get(sessionId)
        state(sessionId).etag = current.etag
        return decodeSnapshot(current.data)
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        if (isStoreAbsent(e)) {
          shutDown(
            `[zerocool-sessions] the daemon session store is not available (${reason}); ` +
              "this session stays on opencode's local disk",
          )
        } else if (!warnedOther) {
          warnedOther = true
          opts.warn(`[zerocool-sessions] restore failed (${reason}); the mirror keeps trying`)
        }
        return undefined
      }
    },

    async flush() {
      if (!running) return
      const due: string[] = []
      for (const [sessionId, s] of tracked) {
        if (s.timer) {
          timers.clearTimeout(s.timer)
          s.timer = undefined
          due.push(sessionId)
        } else if (s.again) {
          s.again = false
          due.push(sessionId)
        }
      }
      await Promise.all(due.map((sessionId) => write(sessionId)))
    },

    stop() {
      running = false
      for (const s of tracked.values()) {
        if (s.timer) timers.clearTimeout(s.timer)
        s.timer = undefined
      }
    },

    active: () => running,
  }
}
