#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// A stand-in for the `opencode` bin that prints its own environment as one
// opencode text event, so a test can assert what the launcher let through.
const text = JSON.stringify(process.env)
process.stdout.write(`${JSON.stringify({ type: "text", sessionID: "ses_env", part: { type: "text", text } })}\n`)
process.stdout.write(`${JSON.stringify({ type: "step_finish", sessionID: "ses_env", part: { type: "step-finish", reason: "stop", tokens: { total: 0, input: 0, output: 0 }, cost: 0 } })}\n`)
