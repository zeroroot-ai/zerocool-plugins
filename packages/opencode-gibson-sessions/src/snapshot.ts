// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { MAX_CONTEXT_BYTES } from "./store.js"

/**
 * The blob this plugin mirrors, and how it is kept under the daemon's cap.
 *
 * The store is opaque: the daemon never reads these bytes, so the format is
 * ours. It is JSON, versioned by `v`, and it holds what opencode itself
 * reports for the session — the session record and its messages. opencode
 * owns its local storage and this is a copy of it, never a replacement.
 */

/** The snapshot format version. Bump it when the shape changes. */
export const SNAPSHOT_VERSION = 1

export interface SessionSnapshot {
  v: number
  sessionId: string
  /** When the mirror wrote it, Unix milliseconds. */
  writtenAt: number
  /** opencode's own session record. */
  session: unknown
  /** opencode's own messages, oldest first. */
  messages: unknown[]
  /**
   * How many of the oldest messages the cap forced out. `0` in the normal
   * case. A reader that sees a non-zero count knows the copy is partial.
   */
  dropped: number
}

/** What the plugin reads opencode's session state through. */
export interface SessionReader {
  read(sessionId: string): Promise<{ session: unknown; messages: unknown[] }>
}

const encoder = new TextEncoder()

/** Encode a snapshot. Exported so the cap and the encoding are tested together. */
export function encodeSnapshot(snapshot: SessionSnapshot): Uint8Array {
  return encoder.encode(JSON.stringify(snapshot))
}

/** Decode a blob the store returned. Returns undefined when it is not ours. */
export function decodeSnapshot(data: Uint8Array): SessionSnapshot | undefined {
  if (data.length === 0) return undefined
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as SessionSnapshot
    if (typeof parsed?.v !== "number" || typeof parsed?.sessionId !== "string") return undefined
    return parsed
  } catch {
    // A blob written by something else, or a truncated one. The mirror
    // overwrites it on the next tick; refusing to start would be worse.
    return undefined
  }
}

/**
 * Build the blob for one session, trimmed to fit the daemon's 8 MB cap.
 *
 * Trimming drops the OLDEST messages first and records how many went, so a
 * long session still checkpoints its recent context instead of failing the
 * write outright. The session record and the header always survive: a
 * snapshot that cannot hold even those is refused, because there is nothing
 * useful left to store.
 */
export function buildSnapshot(
  sessionId: string,
  session: unknown,
  messages: unknown[],
  now: number,
  cap: number = MAX_CONTEXT_BYTES,
): { data: Uint8Array; snapshot: SessionSnapshot } {
  let kept = messages.slice()
  let dropped = 0
  for (;;) {
    const snapshot: SessionSnapshot = {
      v: SNAPSHOT_VERSION,
      sessionId,
      writtenAt: now,
      session,
      messages: kept,
      dropped,
    }
    const data = encodeSnapshot(snapshot)
    if (data.length <= cap) return { data, snapshot }
    if (kept.length === 0) {
      throw new Error(
        `session ${sessionId}: the session record alone is ${data.length} bytes, over the ${cap}-byte store cap`,
      )
    }
    // Drop proportionally to the overshoot, never fewer than one. A message at
    // a time would re-encode the whole blob once per message, which is minutes
    // of CPU on a long session and would run on every debounce tick.
    const overshoot = 1 - cap / data.length
    const drop = Math.min(kept.length, Math.max(1, Math.ceil(kept.length * overshoot)))
    kept = kept.slice(drop)
    dropped += drop
  }
}
