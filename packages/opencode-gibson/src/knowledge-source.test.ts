// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

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

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
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
