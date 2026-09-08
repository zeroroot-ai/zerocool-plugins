// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { openTaskHarness, type TaskHarness } from "@zeroroot-ai/sdk"

import { selectKnowledgeSource } from "./knowledge-source.js"

/**
 * Which grant a run reads the knowledge graph with.
 *
 * The failure this guards is silent: if a dispatched run quietly fell back to
 * the component grant, every read would still work and nobody would notice the
 * run held broader authority than its dispatch granted, with no per-task
 * attribution on anything it read. That is the gap ADR-0006 recorded, and it is
 * only visible if the wrong path is loud.
 */

const fakeSession = { clients: { component: {} } } as never

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  const restore = (): void => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  let out: T
  try {
    out = fn()
  } catch (e) {
    restore()
    throw e
  }
  // An async body must keep the environment until it settles, and a sync one
  // must restore before the caller reads it back. Both, from one helper.
  if (out instanceof Promise) return out.finally(restore) as T
  restore()
  return out
}

/**
 * A CG-JWT shaped grant. `openTaskHarness` decodes the grant's claims to build
 * the `ContextInfo` every callback carries, so the token must be a real JWT
 * shape — an opaque string is refused. No `exp`, so the harness schedules no
 * renewal timer and the test process exits.
 */
const TASK_GRANT =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJjb21wb25lbnQ6YWdlbnQ6emVyb2Nvb2wiLCJ0ZW5hbnQiOiJwcmltYXJ5IiwibWlzc2lvbl9pZCI6Im0tMSIsInRhc2tfaWQiOiJ0LTEifQ.sig"

test("an interactive run keeps the component grant", () => {
  withEnv({ GIBSON_CALLBACK_ENDPOINT: undefined, GIBSON_CALLBACK_TOKEN: undefined }, () => {
    assert.equal(selectKnowledgeSource(fakeSession).scope, "component")
  })
})

test("a dispatched run reads as the task", () => {
  withEnv({ GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: TASK_GRANT }, () => {
    assert.equal(selectKnowledgeSource(fakeSession).scope, "task")
  })
})

test("an endpoint with no token FAILS rather than falling back", () => {
  // The whole point. A fallback here is how the authority gap reappears
  // silently: reads keep working, and nobody learns the run held the
  // component's grant instead of its own.
  withEnv({ GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: undefined }, () => {
    assert.throws(() => selectKnowledgeSource(fakeSession), /would silently\s+widen this run's authority/)
  })
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
  await withEnv({ GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: TASK_GRANT }, async () => {
    const { knowledge, scope, stop } = selectKnowledgeSource(fakeSession, {
      // The real harness, so the context really is derived from the grant.
      // Only the wire client is replaced, so the read reaches no daemon.
      openHarness: (opts) => ({ ...openTaskHarness(opts), client: recordingClient(calls) }),
    })
    assert.equal(scope, "task")
    await knowledge.query({ text: "prior findings for this codebase" })
    stop()
  })

  assert.equal(calls.length, 1)
  assert.equal(sentContext(calls[0]).missionId, "m-1", "the callback service refuses a read with no mission_id")
  assert.equal(sentContext(calls[0]).taskId, "t-1")
  assert.equal(sentContext(calls[0]).agentName, "zerocool", "agent_name is the component the grant was minted for")
})

test("every task-scoped read carries the same context, not only the first", async () => {
  const calls: unknown[] = []
  await withEnv({ GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: TASK_GRANT }, async () => {
    const { knowledge, stop } = selectKnowledgeSource(fakeSession, {
      openHarness: (opts) => ({ ...openTaskHarness(opts), client: recordingClient(calls) }),
    })
    await knowledge.similarFindings("f-1")
    await knowledge.relatedFindings("f-1")
    await knowledge.runHistory()
    stop()
  })

  assert.equal(calls.length, 3)
  for (const c of calls) assert.equal(sentContext(c).missionId, "m-1")
})

test("stopping the source stops the task harness", () => {
  // The harness renews the grant on a timer. A session that ended must not keep
  // renewing a grant for a run that is over.
  let stopped = 0
  withEnv({ GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: TASK_GRANT }, () => {
    const { stop } = selectKnowledgeSource(fakeSession, {
      openHarness: (opts) => {
        const h = openTaskHarness(opts)
        return { ...h, stop: () => { stopped += 1; h.stop() } }
      },
    })
    stop()
  })
  assert.equal(stopped, 1)
})

test("an interactive source stops cleanly although it opened no harness", () => {
  withEnv({ GIBSON_CALLBACK_ENDPOINT: undefined, GIBSON_CALLBACK_TOKEN: undefined }, () => {
    const { scope, stop } = selectKnowledgeSource(fakeSession)
    assert.equal(scope, "component")
    stop()
  })
})
