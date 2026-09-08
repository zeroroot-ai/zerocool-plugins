// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { shellQuote, toDevboxArgv } from "./command.js"

/**
 * From opencode's shell arguments to a `DevboxExec` argv.
 *
 * `DevboxExecRequest` carries `session_id`, `argv` and `stdin` and nothing
 * else — there is no working-directory field — and the server does not
 * shell-interpret argv (gibson `callback_devbox_exec.go`). So the shell is
 * asked for explicitly and a working directory becomes a `cd`.
 */

test("a command becomes an explicit shell invocation", () => {
  assert.deepEqual(toDevboxArgv("go build ./..."), ["sh", "-lc", "go build ./..."])
})

test("a working directory becomes a cd, because DevboxExec carries none", () => {
  assert.deepEqual(toDevboxArgv("make test", "/workspace/repo"), [
    "sh",
    "-lc",
    "cd -- '/workspace/repo' && make test",
  ])
})

test("a quote in the directory cannot end the quoting and run something else", () => {
  const argv = toDevboxArgv("ls", "/tmp/it's here; rm -rf /")
  assert.equal(argv[2], `cd -- '/tmp/it'\\''s here; rm -rf /' && ls`)
})

test("shellQuote wraps and escapes", () => {
  assert.equal(shellQuote("plain"), "'plain'")
  assert.equal(shellQuote("a'b"), `'a'\\''b'`)
})
