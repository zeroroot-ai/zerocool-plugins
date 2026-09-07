// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { trimLeadingSlashes, trimTrailingSlashes } from "./text.js"

test("trimTrailingSlashes removes every trailing slash and nothing else", () => {
  assert.equal(trimTrailingSlashes("https://gibson:50051///"), "https://gibson:50051")
  assert.equal(trimTrailingSlashes("https://gibson:50051"), "https://gibson:50051")
  assert.equal(trimTrailingSlashes("/"), "")
  assert.equal(trimTrailingSlashes(""), "")
  assert.equal(trimTrailingSlashes("a/b/"), "a/b")
})

test("trimLeadingSlashes removes every leading slash and nothing else", () => {
  assert.equal(trimLeadingSlashes("///group/project"), "group/project")
  assert.equal(trimLeadingSlashes("group/project"), "group/project")
  assert.equal(trimLeadingSlashes("/"), "")
  assert.equal(trimLeadingSlashes(""), "")
})

test("a long run of slashes is read once, not rescanned", () => {
  const slashes = "/".repeat(200_000)
  assert.equal(trimTrailingSlashes(`x${slashes}`), "x")
  assert.equal(trimLeadingSlashes(`${slashes}x`), "x")
  assert.equal(trimTrailingSlashes(`${slashes}x`), `${slashes}x`)
})
