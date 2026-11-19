#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// A stand-in for the `opencode` bin for a test that must read the child
// environment and the arguments without the Task. It writes both to the file
// that ZEROCOOL_TEST_PROBE_OUT names. It then prints the grant in its output,
// or in its error output and exits 1 when ZEROCOOL_TEST_PROBE_FAIL is set, so
// a test can prove that the worker removes the grant from what it submits.
import { writeFileSync } from "node:fs"

const grant = process.env.GIBSON_CALLBACK_TOKEN ?? ""
writeFileSync(process.env.ZEROCOOL_TEST_PROBE_OUT, JSON.stringify({ env: process.env, argv: process.argv.slice(2) }))
if (process.env.ZEROCOOL_TEST_PROBE_FAIL) {
  console.error(`boom with ${grant}`)
  process.exit(1)
}
const text = `the grant is ${grant}`
process.stdout.write(`${JSON.stringify({ type: "text", sessionID: "ses_probe", part: { type: "text", text } })}\n`)
process.stdout.write(`${JSON.stringify({ type: "step_finish", sessionID: "ses_probe", part: { type: "step-finish", reason: "stop", tokens: { total: 0, input: 0, output: 0 }, cost: 0 } })}\n`)
