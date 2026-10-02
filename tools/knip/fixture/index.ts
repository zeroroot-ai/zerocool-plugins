// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// The barrel shape every package in this repository uses. The selftest proves
// knip reports the runner's unused exports THROUGH this re-export, which is
// the shape that hid `runClaude` (zerocool-plugins#102).
export * from "./runner.js"
export { usedHelper } from "./helper.js"

usedHelper()
