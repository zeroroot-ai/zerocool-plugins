#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { runHook, type HookInput } from "./hook-run.js"

/**
 * The hook bin. Runs unconditionally: npm installs it as a symlink named
 * `zerocool-claude-hook`, so an argv[1] guard would never match. Library
 * code lives in hook-run.ts.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

readStdin()
  .then((raw) => runHook(raw ? (JSON.parse(raw) as HookInput) : {}, process.env))
  .then((out) => {
    if (out) process.stdout.write(out)
    process.exit(0)
  })
  .catch((e: Error) => {
    process.stderr.write(`[zerocool-claude hook] ${e.message}\n`)
    process.exit(0) // fail open: a hook error must not block the session
  })
