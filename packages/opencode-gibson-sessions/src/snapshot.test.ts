// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { buildSnapshot, decodeSnapshot, encodeSnapshot, SNAPSHOT_VERSION } from "./snapshot.js"

/**
 * The blob, and the daemon's 8 MB cap.
 *
 * The daemon refuses an oversized write with ResourceExhausted, so a session
 * that grew past the cap would stop checkpointing at exactly the point it
 * became worth checkpointing. Trimming the oldest messages keeps the recent
 * context, and records that it did.
 */

test("a snapshot round-trips", () => {
  const { data, snapshot } = buildSnapshot("ses_1", { id: "ses_1" }, [{ id: "m1" }], 42)
  assert.equal(snapshot.v, SNAPSHOT_VERSION)
  assert.equal(snapshot.dropped, 0)
  const back = decodeSnapshot(data)
  assert.equal(back?.sessionId, "ses_1")
  assert.equal(back?.writtenAt, 42)
  assert.equal(back?.messages.length, 1)
})

test("an oversized session drops its oldest messages and says how many", () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, text: "x".repeat(100) }))
  const { data, snapshot } = buildSnapshot("ses_1", { id: "ses_1" }, messages, 1, 4096)

  assert.ok(data.length <= 4096, `the blob is ${data.length} bytes, over the cap`)
  assert.ok(snapshot.dropped > 0)
  assert.equal(snapshot.messages.length + snapshot.dropped, messages.length)
  assert.deepEqual(
    snapshot.messages.at(-1),
    messages.at(-1),
    "the newest message is the one that must survive the trim",
  )
})

test("a session record that alone exceeds the cap is refused, not silently emptied", () => {
  assert.throws(
    () => buildSnapshot("ses_1", { blob: "x".repeat(9000) }, [], 1, 4096),
    /over the 4096-byte store cap/,
  )
})

test("an empty read is not a snapshot", () => {
  assert.equal(decodeSnapshot(new Uint8Array()), undefined)
})

test("a blob written by something else decodes to undefined rather than throwing", () => {
  assert.equal(decodeSnapshot(new TextEncoder().encode("not json")), undefined)
  assert.equal(decodeSnapshot(encodeSnapshot({ hello: "world" } as never)), undefined)
})
