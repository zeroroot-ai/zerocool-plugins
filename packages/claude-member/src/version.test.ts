// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { compareVersions, parseClaudeVersion, PINNED_CLAUDE_CODE_VERSION, versionIsSupported } from "./version.js"

test("the pinned version is the one the fixtures came from", () => {
  assert.equal(PINNED_CLAUDE_CODE_VERSION, "2.1.257")
})

test("parseClaudeVersion reads what `claude --version` prints", () => {
  assert.equal(parseClaudeVersion("2.1.257 (Claude Code)\n"), "2.1.257")
  assert.equal(parseClaudeVersion("nothing here"), "")
})

test("the pin is a floor: a newer CLI is supported, an older one is not", () => {
  assert.ok(versionIsSupported("2.1.257"))
  assert.ok(versionIsSupported("2.2.0"))
  assert.ok(versionIsSupported("10.0.0"))
  assert.ok(!versionIsSupported("2.1.256"))
  assert.ok(!versionIsSupported(""))
  assert.ok(compareVersions("2.1.9", "2.1.10") < 0, "components compare as numbers, not strings")
})
