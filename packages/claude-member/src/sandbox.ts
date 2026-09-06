#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { runOneShot } from "./oneshot-run.js"

/**
 * The one-shot dispatch bin. npm installs it as `zerocool-claude-dispatch`,
 * and the image entrypoint runs it. Library code lives in `oneshot-run.ts`.
 */
async function main(): Promise<void> {
  const log = (l: string) => process.stderr.write(`[zerocool-claude-dispatch] ${l}\n`)
  try {
    const outcome = await runOneShot({
      env: process.env,
      onEvent: (line) => process.stdout.write(`${line}\n`),
      log,
    })
    for (const d of outcome.deliverables) {
      log(`deliverable ${d.repository} ${d.deliverable} branch=${d.branch} commits=${d.commits} mr=${d.mergeRequestUrl || "-"} ${d.error ? `error=${d.error}` : ""}`.trim())
    }
    log(`done job=${outcome.jobId} turns=${outcome.turns} cost_usd=${outcome.costUsd.toFixed(4)} session=${outcome.claudeSessionId || "-"} error=${outcome.isError}`)
    process.exit(outcome.isError ? 1 : 0)
  } catch (e) {
    log(`run failed: ${(e as Error).message}`)
    process.exit(1)
  }
}

main().catch((e: Error) => {
  process.stderr.write(`[zerocool-claude-dispatch] fatal: ${e.message}\n`)
  process.exit(1)
})
