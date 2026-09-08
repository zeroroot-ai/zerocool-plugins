// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { runOnHost } from "./host.js"

/** The fallback backend. It must report an outcome as honestly as the Devbox one. */

test("a command that runs reports its exit code and its output", async () => {
  const result = await runOnHost(["sh", "-lc", "echo out; echo err 1>&2; exit 3"], {})
  assert.equal(result.outcome, "exited")
  assert.equal(result.exitCode, 3)
  assert.match(result.output, /out/)
  assert.match(result.output, /err/)
})

test("a binary that does not exist is an error, not a zero exit", async () => {
  const result = await runOnHost(["this-binary-does-not-exist-zerocool"], {})
  assert.equal(result.outcome, "error")
  assert.notEqual(result.message, "")
})

test("stdin is delivered and closed, so a command that reads to EOF finishes", async () => {
  const result = await runOnHost(["sh", "-lc", "cat"], { stdin: new TextEncoder().encode("hello") })
  assert.equal(result.outcome, "exited")
  assert.equal(result.output, "hello")
})

test("a command killed by a signal has an UNKNOWN outcome, never a zero exit", async () => {
  const controller = new AbortController()
  const running = runOnHost(["sh", "-lc", "sleep 30"], { signal: controller.signal })
  controller.abort()
  const result = await running
  assert.notEqual(result.outcome, "exited")
})
