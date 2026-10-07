// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { Watcher } from "@zeroroot-ai/sdk"
import type { OneShotOutcome } from "./oneshot.js"
import { runForkable } from "./oneshot-run.js"

/** The one-shot driver as a fork source (D74). */

const outcome = (jobId: string, isError = false): OneShotOutcome => ({ jobId, isError }) as unknown as OneShotOutcome

test("a fork source parks after a passing run, and a fork runs the task of its claim", async () => {
  const runs: string[] = []
  const parks: string[] = []
  const reported: string[] = []
  const result = await runForkable({
    env: { GIBSON_MISSION_ID: "parent-1", GIBSON_CALLBACK_INSECURE: "1" },
    watcher: Watcher.withReader(() => "sbx"),
    run: async (o) => {
      runs.push(o.env.GIBSON_MISSION_ID ?? "")
      return outcome(`job-${runs.length}`)
    },
    park: async (env, _w, opts) => {
      parks.push(`${env.GIBSON_MISSION_ID} insecure=${opts?.insecure}`)
      return env.GIBSON_MISSION_ID === "parent-1" ? { GIBSON_MISSION_ID: "child-1" } : undefined
    },
    onOutcome: (o) => reported.push(o.jobId),
  })
  assert.deepEqual(runs, ["parent-1", "child-1"], "the fork runs its own task")
  assert.deepEqual(parks, ["parent-1 insecure=true", "child-1 insecure=false"])
  assert.deepEqual(reported, ["job-1", "job-2"], "each run reports its result")
  assert.equal(result.jobId, "job-2")
})

test("the parent returns its outcome when the park ends with no fork", async () => {
  let runs = 0
  const result = await runForkable({
    env: {},
    watcher: Watcher.withReader(() => "sbx"),
    run: async () => outcome(`job-${++runs}`),
    park: async () => undefined,
  })
  assert.equal(runs, 1)
  assert.equal(result.jobId, "job-1")
})

test("a failed run does not park", async () => {
  let parked = false
  const result = await runForkable({
    env: {},
    watcher: Watcher.withReader(() => "sbx"),
    run: async () => outcome("job-1", true),
    park: async () => {
      parked = true
      return undefined
    },
  })
  assert.equal(result.isError, true)
  assert.equal(parked, false)
})
