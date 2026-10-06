// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { parseClaudeVersion } from "./version.js"

test("parseClaudeVersion reads what `claude --version` prints", () => {
  assert.equal(parseClaudeVersion("2.1.257 (Claude Code)\n"), "2.1.257")
  assert.equal(parseClaudeVersion("nothing here"), "")
})

test("parseClaudeVersion takes the first dotted triple and reads long output once", () => {
  assert.equal(parseClaudeVersion("v2.1.257-beta"), "2.1.257")
  assert.equal(parseClaudeVersion("1.2.3.4"), "1.2.3")
  assert.equal(parseClaudeVersion("build 12 then 3.4.5 later"), "3.4.5")
  assert.equal(parseClaudeVersion("1..2.3"), "")
  assert.equal(parseClaudeVersion(""), "")
  assert.equal(parseClaudeVersion("9".repeat(200_000)), "")
  assert.equal(parseClaudeVersion(`${"9".repeat(200_000)} 2.1.257`), "2.1.257")
})
