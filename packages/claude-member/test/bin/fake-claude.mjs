#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// A stand-in for the `claude` CLI in driver tests. It replays a captured
// stream-json fixture and records what it was called with, so a test can
// assert the argv and the child environment without a model or a key.
//
// The knobs are named CLAUDE_* on purpose: the driver builds a child
// environment from an allow list, and that allow list is one of the things
// these tests check. A name outside it never reaches this process.
//
//   CLAUDE_FAKE_FIXTURE   the .jsonl file to replay (required)
//   CLAUDE_FAKE_RECORD    where to append one JSON line per invocation
//   CLAUDE_FAKE_HANG_MS   stay alive this long after the replay, so a test
//                         can send SIGINT or SIGTERM mid-turn
//   CLAUDE_FAKE_EXIT      exit code, default 0
import { appendFileSync, readFileSync } from "node:fs"

const fixture = process.env.CLAUDE_FAKE_FIXTURE
if (!fixture) {
  process.stderr.write("CLAUDE_FAKE_FIXTURE is not set\n")
  process.exit(2)
}

let stdin = ""
process.stdin.on("data", (d) => {
  stdin += d.toString()
})

const record = () => {
  if (!process.env.CLAUDE_FAKE_RECORD) return
  appendFileSync(
    process.env.CLAUDE_FAKE_RECORD,
    `${JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), stdin })}\n`,
  )
}

const hang = Number(process.env.CLAUDE_FAKE_HANG_MS ?? 0)
let interrupted = false

const replay = () => {
  for (const line of readFileSync(fixture, "utf8").split("\n")) {
    if (line.trim()) process.stdout.write(`${line}\n`)
  }
}

const finish = (code) => {
  record()
  process.exit(code)
}

process.on("SIGINT", () => {
  interrupted = true
  // Claude Code records a result on SIGINT and exits 0.
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, total_cost_usd: 0.01, session_id: "interrupted-session", result: "interrupted" })}\n`)
  finish(0)
})
process.on("SIGTERM", () => {
  // Claude Code records no result on SIGTERM and exits 143.
  interrupted = true
  finish(143)
})

setTimeout(() => {
  replay()
  if (hang > 0) {
    setTimeout(() => {
      if (!interrupted) finish(Number(process.env.CLAUDE_FAKE_EXIT ?? 0))
    }, hang)
  } else {
    finish(Number(process.env.CLAUDE_FAKE_EXIT ?? 0))
  }
}, 10)
