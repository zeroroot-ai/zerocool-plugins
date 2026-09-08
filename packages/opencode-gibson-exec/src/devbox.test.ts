// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { runInDevbox, type DevboxExecCall, type DevboxExecMessage } from "./devbox.js"

/**
 * The stream contract, which is the whole reason `DevboxExec` is a stream.
 *
 * gibson guarantees exactly one terminal message per healthy stream: an exit,
 * or an error. A stream that ends without one was cut by transport or server
 * failure. "The command succeeded" and "the connection dropped" must never
 * look alike to the caller, so a missing terminal event is an UNKNOWN outcome
 * and never a zero exit code.
 */

const utf8 = new TextEncoder()
const out = (s: string): DevboxExecMessage => ({ payload: { case: "stdout", value: utf8.encode(s) } })
const err = (s: string): DevboxExecMessage => ({ payload: { case: "stderr", value: utf8.encode(s) } })
const exit = (code: number): DevboxExecMessage => ({ payload: { case: "exit", value: { exitCode: code } } })

/** A `DevboxExec` that replays the given messages and records the request. */
function fakeExec(messages: DevboxExecMessage[], seen: unknown[] = []): DevboxExecCall {
  return (req) => {
    seen.push(req)
    return (async function* () {
      for (const m of messages) yield m
    })()
  }
}

test("stdout and stderr arrive interleaved, in the order the stream sent them", async () => {
  const result = await runInDevbox(fakeExec([out("one "), err("two "), out("three"), exit(0)]), {
    sessionId: "ses_1",
    argv: ["sh", "-lc", "echo"],
  })
  assert.equal(result.outcome, "exited")
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, "one two three", "chunk boundaries are transport artifacts, never reordered")
})

test("a non-zero exit is a completed command, not a failure to run it", async () => {
  const result = await runInDevbox(fakeExec([out("boom"), exit(2)]), { sessionId: "ses_1", argv: ["sh"] })
  assert.equal(result.outcome, "exited")
  assert.equal(result.exitCode, 2)
})

test("a stream that ends with no exit event is UNKNOWN, never success", async () => {
  const result = await runInDevbox(fakeExec([out("partial output")]), { sessionId: "ses_1", argv: ["sh"] })
  assert.equal(result.outcome, "unknown")
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, "partial output", "what did arrive is still reported")
  assert.match(result.message, /no exit event/)
})

test("an error event is terminal and carries its message", async () => {
  const result = await runInDevbox(
    fakeExec([{ payload: { case: "error", value: { message: "the sandbox died" } } }]),
    { sessionId: "ses_1", argv: ["sh"] },
  )
  assert.equal(result.outcome, "error")
  assert.equal(result.message, "the sandbox died")
})

test("the request carries the session id and the argv, and an empty stdin by default", async () => {
  const seen: unknown[] = []
  await runInDevbox(fakeExec([exit(0)], seen), { sessionId: "ses_7", argv: ["sh", "-lc", "make test"] })
  assert.deepEqual(seen, [{ sessionId: "ses_7", argv: ["sh", "-lc", "make test"], stdin: new Uint8Array() }])
})

test("a multi-byte character split across two chunks decodes whole", async () => {
  const bytes = utf8.encode("é")
  const result = await runInDevbox(
    fakeExec([
      { payload: { case: "stdout", value: bytes.slice(0, 1) } },
      { payload: { case: "stdout", value: bytes.slice(1) } },
      exit(0),
    ]),
    { sessionId: "ses_1", argv: ["sh"] },
  )
  assert.equal(result.output, "é")
})

test("nothing is read past the terminal event", async () => {
  let readPastExit = false
  const exec: DevboxExecCall = () =>
    (async function* () {
      yield out("done")
      yield exit(0)
      readPastExit = true
      yield out("never")
    })()
  const result = await runInDevbox(exec, { sessionId: "ses_1", argv: ["sh"] })
  assert.equal(result.output, "done")
  assert.equal(readPastExit, false)
})
