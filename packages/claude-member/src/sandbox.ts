#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { Watcher } from "@zeroroot-ai/sdk"
import { runForkable } from "./oneshot-run.js"

/**
 * The one-shot dispatch bin. npm installs it as `zerocool-claude-dispatch`,
 * and the image entrypoint runs it. Library code lives in `oneshot-run.ts`.
 */
async function main(): Promise<void> {
  const log = (l: string) => process.stderr.write(`[zerocool-claude-dispatch] ${l}\n`)
  // Made before any run, so a fork of this process sees its new sandbox id (D74).
  const watcher = Watcher.create()
  try {
    const outcome = await runForkable({
      env: process.env,
      watcher,
      onEvent: (line) => process.stdout.write(`${line}\n`),
      onOutcome: (o) => {
        for (const d of o.deliverables) {
          log(`deliverable ${d.repository} ${d.deliverable} branch=${d.branch} commits=${d.commits} mr=${d.mergeRequestUrl || "-"} ${d.error ? `error=${d.error}` : ""}`.trim())
        }
        log(`done job=${o.jobId} turns=${o.turns} cost_usd=${o.costUsd.toFixed(4)} session=${o.claudeSessionId || "-"} error=${o.isError}`)
      },
      log,
    })
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
