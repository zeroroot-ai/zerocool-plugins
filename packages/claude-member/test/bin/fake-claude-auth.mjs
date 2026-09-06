#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// A stand-in for `claude auth login` and `claude auth status --json`, shaped
// by the spike on zeroroot-ai/gibson#1715 against Claude Code 2.1.257.
//
//   FAKE_AUTH_STATE   file that holds "in" once the login succeeded
//   FAKE_AUTH_CODE    the code that is accepted; anything else is refused
//   FAKE_AUTH_EXIT    exit code for `auth login`, default 0
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const [, , ...argv] = process.argv
const state = process.env.FAKE_AUTH_STATE ?? "/tmp/fake-auth-state"
const good = process.env.FAKE_AUTH_CODE ?? "the-right-code"

if (argv[0] === "auth" && argv[1] === "status") {
  const loggedIn = existsSync(state) && readFileSync(state, "utf8").trim() === "in"
  process.stdout.write(
    `${JSON.stringify(loggedIn ? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", expiresAt: "2026-12-01T00:00:00.000Z" } : { loggedIn: false })}\n`,
  )
  process.exit(0)
}

function login() {
  process.stdout.write("Opening browser to sign in…\n")
  process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc\n")
  process.stdout.write("Paste code here if prompted > ")
  let buf = ""
  process.stdin.on("data", (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const code = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (code === good) {
        writeFileSync(state, "in")
        process.stdout.write("Signed in.\n")
        process.exit(Number(process.env.FAKE_AUTH_EXIT ?? 0))
      }
      // A wrong code is refused on stderr and the CLI keeps waiting.
      process.stderr.write("Invalid code. Please make sure the full code was copied.\n")
      process.stdout.write("Paste code here if prompted > ")
    }
  })
}

if (argv[0] === "auth" && argv[1] === "login") {
  login()
} else {
  process.stderr.write(`fake-claude-auth: unexpected argv ${argv.join(" ")}\n`)
  process.exit(2)
}
