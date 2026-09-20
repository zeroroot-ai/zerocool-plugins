#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// The hook entry Claude Code runs (hooks.json, exec form: `node` plus this
// path, which works on every platform). It runs this package's own hook bin
// from the registry at this package's own version, so a session never runs a
// floating tag.
//
// The version below is the one line release-please bumps: the annotation on
// it is what the generic updater looks for, and release-please-config.json
// lists this file under the package's extra-files. The guard in
// src/pins.test.ts fails when the line, the annotation or the config entry
// goes missing, never after a routine release.
//
// No import outside node's own modules: the plugin directory carries no
// node_modules.
import { spawn } from "node:child_process"

const VERSION = "0.6.2" // x-release-please-version
const PACKAGE = `@zeroroot-ai/zerocool-claude@${VERSION}`
const BIN = "zerocool-claude-hook"

// npx on Windows is a .cmd shim, which only a shell can start. The argv is
// three constants, so the shell sees nothing a person typed.
const child = spawn("npx", ["--yes", "--package", PACKAGE, BIN], { stdio: "inherit", shell: process.platform === "win32" })
child.on("error", (e) => {
  // Fail open, like the bin: a hook error must not block the session.
  process.stderr.write(`[zerocool-claude hook] cannot run npx: ${e.message}\n`)
  process.exit(0)
})
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
