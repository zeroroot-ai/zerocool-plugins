// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { openTaskHarness, type TaskHarness } from "@zeroroot-ai/sdk"

import { openTaskRun, selectKnowledgeSource } from "./knowledge-source.js"

/**
 * Which grant a run reads the knowledge graph with.
 *
 * The failure this guards is silent: if a dispatched run quietly fell back to
 * the component grant, every read would still work and nobody would notice the
 * run held broader authority than its dispatch granted, with no per-task
 * attribution on anything it read. That is the gap ADR-0156 recorded, and it is
 * only visible if the wrong path is loud.
 */

const fakeSession = { clients: { component: {} } } as never

/** The child contract: the grant and the endpoint, and nothing of the launch environment. */
const taskEnv = (token: string): NodeJS.ProcessEnv => ({ GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: token })

/**
 * A CG-JWT shaped grant. `openTaskHarness` decodes the grant's claims to build
 * the `ContextInfo` every callback carries, so the token must be a real JWT
 * shape — an opaque string is refused. It names the mission run in the `mrid`
 * claim, which sdk 0.20 requires. No `exp`, so the harness schedules no
 * renewal timer and the test process exits.
 */
const TASK_GRANT =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJjb21wb25lbnQ6YWdlbnQ6emVyb2Nvb2wiLCJ0ZW5hbnQiOiJwcmltYXJ5IiwibWlzc2lvbl9pZCI6Im0tMSIsInRhc2tfaWQiOiJ0LTEiLCJtcmlkIjoicnVuLTEifQ.sig"

test("an interactive run keeps the component grant and has no harness", () => {
  const sel = selectKnowledgeSource(fakeSession)
  assert.equal(sel.scope, "component")
  assert.equal((sel as { harness?: unknown }).harness, undefined, "no task grant, so no model resolution")
  sel.stop()
})

test("a dispatched run reads as the task, on the one harness of the model path", () => {
  const sel = openTaskRun(taskEnv(TASK_GRANT))
  assert.equal(sel.scope, "task")
  assert.equal(sel.harness.token(), TASK_GRANT, "resolveModel and the gateway grant come from this harness")
  sel.stop()
})

test("a half-set pair FAILS rather than falling back", () => {
  // The whole point. A fallback here is how the authority gap reappears
  // silently: reads keep working, and nobody learns the run held the
  // component's grant instead of its own.
  assert.throws(() => openTaskRun({ GIBSON_CALLBACK_ENDPOINT: "gibson:50001" }), /would silently\s+widen this run's authority/)
  assert.throws(() => openTaskRun({ GIBSON_CALLBACK_TOKEN: TASK_GRANT }), /must both be set/)
})

/**
 * What a task-scoped read actually sends (zerocool-plugins#8).
 *
 * Every HarnessCallbackService RPC resolves the harness from
 * `ContextInfo{mission_id, agent_name}` and is refused before authorization
 * runs if it carries none. `openTaskHarness` derives that context from the
 * grant's own claims, which is why `connectTaskHarness` never worked live.
 * These tests pin the derivation end to end: the grant goes in, and the
 * request the knowledge source puts on the wire carries `context.mission_id`.
 */

/** A recording HarnessCallbackService client. Records what each read sends. */
function recordingClient(calls: unknown[]): TaskHarness["client"] {
  const record = async (req: unknown): Promise<unknown> => {
    calls.push(req)
    return { results: [], runs: [], findings: [] }
  }
  return {
    queryNodes: record,
    findSimilarFindings: record,
    getRelatedFindings: record,
    getMissionRunHistory: record,
  } as unknown as TaskHarness["client"]
}

/** The context a request carried, as the callback service reads it. */
const sentContext = (req: unknown): { missionId?: string; taskId?: string; agentName?: string } =>
  (req as { context?: { missionId?: string; taskId?: string; agentName?: string } }).context ?? {}

test("a dispatched read carries context.mission_id, taken from the dispatch grant", async () => {
  const calls: unknown[] = []
  {
    const { knowledge, scope, stop } = openTaskRun(taskEnv(TASK_GRANT), {
      // The real harness, so the context really is derived from the grant.
      // Only the wire client is replaced, so the read reaches no daemon.
      openHarness: (opts) => ({ ...openTaskHarness(opts), client: recordingClient(calls) }),
    })
    assert.equal(scope, "task")
    await knowledge.query({ text: "prior findings for this codebase" })
    stop()
  }

  assert.equal(calls.length, 1)
  assert.equal(sentContext(calls[0]).missionId, "m-1", "the callback service refuses a read with no mission_id")
  assert.equal(sentContext(calls[0]).taskId, "t-1")
  assert.equal(sentContext(calls[0]).agentName, "zerocool", "agent_name is the component the grant was minted for")
})

test("every task-scoped read carries the same context, not only the first", async () => {
  const calls: unknown[] = []
  {
    const { knowledge, stop } = openTaskRun(taskEnv(TASK_GRANT), {
      openHarness: (opts) => ({ ...openTaskHarness(opts), client: recordingClient(calls) }),
    })
    await knowledge.similarFindings("f-1")
    await knowledge.relatedFindings("f-1")
    await knowledge.runHistory()
    stop()
  }

  assert.equal(calls.length, 3)
  for (const c of calls) assert.equal(sentContext(c).missionId, "m-1")
})

test("stopping the source stops the task harness", () => {
  // The harness renews the grant on a timer. A session that ended must not keep
  // renewing a grant for a run that is over.
  let stopped = 0
  {
    const { stop } = openTaskRun(taskEnv(TASK_GRANT), {
      openHarness: (opts) => {
        const h = openTaskHarness(opts)
        return { ...h, stop: () => { stopped += 1; h.stop() } }
      },
    })
    stop()
  }
  assert.equal(stopped, 1)
})

test("an interactive source stops cleanly although it opened no harness", () => {
  const { scope, stop } = selectKnowledgeSource(fakeSession)
  assert.equal(scope, "component")
  stop()
})
