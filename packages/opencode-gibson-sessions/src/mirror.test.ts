// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { Code, ConnectError } from "@connectrpc/connect"

import { startMirror } from "./mirror.js"
import { decodeSnapshot } from "./snapshot.js"
import type { SessionContextStore, StoredContext } from "./store.js"

/**
 * The mirror, at the three points where it can go wrong silently.
 *
 * A checkpoint that never fires loses the session it was supposed to save. A
 * checkpoint that clobbers a newer version loses somebody else's. And a
 * checkpoint that keeps throwing at an absent store turns a working coding
 * agent into a broken one, which is the failure the fail-open discipline in
 * the main plugin exists to prevent.
 */

/** A fake store that records every call and answers from an in-memory blob. */
class FakeStore implements SessionContextStore {
  puts: { sessionId: string; ifMatch: string; data: Uint8Array }[] = []
  gets: string[] = []
  blob: Uint8Array = new Uint8Array()
  etag = ""
  /** Errors to throw, one per call, oldest first. */
  putErrors: unknown[] = []
  getErrors: unknown[] = []
  version = 0

  async get(sessionId: string): Promise<StoredContext> {
    this.gets.push(sessionId)
    const e = this.getErrors.shift()
    if (e) throw e
    return { data: this.blob, etag: this.etag }
  }

  async put(sessionId: string, data: Uint8Array, ifMatch: string): Promise<string> {
    this.puts.push({ sessionId, ifMatch, data })
    const e = this.putErrors.shift()
    if (e) throw e
    this.blob = data
    this.version += 1
    this.etag = `v${this.version}`
    return this.etag
  }
}

/** Timers a test drives by hand, so no test waits on a real clock. */
function fakeTimers(): { timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">; run: () => void } {
  const pending = new Map<number, () => void>()
  let next = 1
  const timers = {
    setTimeout: ((fn: () => void) => {
      const id = next++
      pending.set(id, fn)
      return id as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof globalThis.setTimeout,
    clearTimeout: ((id: number) => {
      pending.delete(id)
    }) as unknown as typeof globalThis.clearTimeout,
  }
  return {
    timers,
    run: () => {
      const due = [...pending.values()]
      pending.clear()
      for (const fn of due) fn()
    },
  }
}

const reader = (messages: unknown[] = [{ id: "m1" }]) => ({
  read: async () => ({ session: { id: "ses_1", title: "t" }, messages }),
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

test("an event checkpoints the session to the store", async () => {
  const store = new FakeStore()
  const { timers, run } = fakeTimers()
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: () => {}, timers, clock: () => 1000 })

  mirror.touch("ses_1")
  run()
  await settle()

  assert.equal(store.puts.length, 1)
  assert.equal(store.puts[0]!.sessionId, "ses_1")
  const snapshot = decodeSnapshot(store.puts[0]!.data)
  assert.equal(snapshot?.sessionId, "ses_1")
  assert.equal(snapshot?.messages.length, 1)
  assert.equal(snapshot?.writtenAt, 1000)
})

test("many events inside the window write once", async () => {
  const store = new FakeStore()
  const { timers, run } = fakeTimers()
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: () => {}, timers })

  for (let i = 0; i < 20; i++) mirror.touch("ses_1")
  run()
  await settle()

  assert.equal(store.puts.length, 1, "the hooks fire per message; the store must not see one write each")
})

test("the first write creates, and the next carries the etag it produced", async () => {
  const store = new FakeStore()
  const { timers, run } = fakeTimers()
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: () => {}, timers })

  mirror.touch("ses_1")
  run()
  await settle()
  mirror.touch("ses_1")
  run()
  await settle()

  assert.deepEqual(
    store.puts.map((p) => p.ifMatch),
    ["", "v1"],
    "an empty if_match is create-only; a second blind create is refused with Aborted",
  )
})

test("a lost etag race is read back and retried once", async () => {
  const store = new FakeStore()
  store.putErrors = [new ConnectError("stale if_match", Code.Aborted)]
  store.etag = "v9"
  const { timers, run } = fakeTimers()
  const warnings: string[] = []
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: (m) => warnings.push(m), timers })

  mirror.touch("ses_1")
  run()
  await settle()

  assert.equal(store.gets.length, 1, "a conflict must read the current version before it writes again")
  assert.deepEqual(
    store.puts.map((p) => p.ifMatch),
    ["", "v9"],
    "the retry writes on top of the version the store reported",
  )
  assert.deepEqual(warnings, [], "a conflict the retry resolved is not a warning")
  assert.equal(mirror.active(), true)
})

test("an absent store warns once and stops the mirror", async () => {
  const store = new FakeStore()
  store.putErrors = [new ConnectError("no session store on this daemon", Code.Unavailable)]
  const { timers, run } = fakeTimers()
  const warnings: string[] = []
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: (m) => warnings.push(m), timers })

  mirror.touch("ses_1")
  run()
  await settle()

  assert.equal(mirror.active(), false, "Unavailable is not transient; retrying it forever helps nobody")
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /local disk/)

  // Every later event is a no-op, and opencode carries the session itself.
  mirror.touch("ses_1")
  run()
  await settle()
  assert.equal(store.puts.length, 1)
  assert.equal(warnings.length, 1, "one warning, not one per event")
})

test("Unimplemented stops the mirror too — the endpoint does not serve the store", async () => {
  const store = new FakeStore()
  store.putErrors = [new ConnectError("unknown method", Code.Unimplemented)]
  const { timers, run } = fakeTimers()
  const warnings: string[] = []
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: (m) => warnings.push(m), timers })

  mirror.touch("ses_1")
  run()
  await settle()

  assert.equal(mirror.active(), false)
  assert.equal(warnings.length, 1)
})

test("a transient failure warns once and keeps mirroring", async () => {
  const store = new FakeStore()
  store.putErrors = [new ConnectError("connection reset", Code.Internal)]
  const { timers, run } = fakeTimers()
  const warnings: string[] = []
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: (m) => warnings.push(m), timers })

  mirror.touch("ses_1")
  run()
  await settle()
  assert.equal(mirror.active(), true, "a network blip must not cost the rest of the session its durable copy")

  mirror.touch("ses_1")
  run()
  await settle()
  assert.equal(store.puts.length, 2)
  assert.equal(warnings.length, 1, "one warning per failure class, not one per event")
})

test("restore adopts the stored etag, so the first write is not a blind create", async () => {
  const store = new FakeStore()
  store.blob = new TextEncoder().encode(
    JSON.stringify({ v: 1, sessionId: "ses_1", writtenAt: 5, session: {}, messages: [{ id: "a" }], dropped: 0 }),
  )
  store.etag = "v7"
  const { timers, run } = fakeTimers()
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: () => {}, timers })

  const prior = await mirror.restore("ses_1")
  assert.equal(prior?.messages.length, 1)

  mirror.touch("ses_1")
  run()
  await settle()
  assert.equal(store.puts[0]!.ifMatch, "v7", "a create against an existing blob is refused with Aborted")
})

test("restore of a session with no blob is not an error", async () => {
  const store = new FakeStore()
  const { timers } = fakeTimers()
  const warnings: string[] = []
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: (m) => warnings.push(m), timers })

  assert.equal(await mirror.restore("ses_new"), undefined)
  assert.deepEqual(warnings, [])
  assert.equal(mirror.active(), true)
})

test("restore against an absent store degrades instead of failing the start", async () => {
  const store = new FakeStore()
  store.getErrors = [new ConnectError("no session store", Code.Unavailable)]
  const { timers } = fakeTimers()
  const warnings: string[] = []
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: (m) => warnings.push(m), timers })

  assert.equal(await mirror.restore("ses_1"), undefined)
  assert.equal(mirror.active(), false)
  assert.equal(warnings.length, 1)
})

test("flush writes the pending checkpoint the debounce window still held", async () => {
  const store = new FakeStore()
  const { timers } = fakeTimers()
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: () => {}, timers })

  mirror.touch("ses_1")
  await mirror.flush()

  assert.equal(store.puts.length, 1, "opencode exiting inside the window must not lose the final turn")
})

test("the mirror calls only the session-context RPCs", async () => {
  // The third acceptance criterion of zerocool-plugins#11: local context is
  // never written to the untrusted Devbox. The store RPCs are the only ones
  // this plugin may touch — a workspace write would put it on that volume.
  const seen: string[] = []
  const store: SessionContextStore = {
    async get(sessionId) {
      seen.push("get")
      void sessionId
      return { data: new Uint8Array(), etag: "" }
    },
    async put() {
      seen.push("put")
      return "v1"
    },
  }
  const { timers, run } = fakeTimers()
  const mirror = startMirror({ store, reader: reader(), debounceMs: 5, warn: () => {}, timers })
  await mirror.restore("ses_1")
  mirror.touch("ses_1")
  run()
  await settle()

  assert.deepEqual(seen, ["get", "put"])
})
