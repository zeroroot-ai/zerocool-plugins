// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { ClaudeHandle, ClaudeRunOptions } from "./claude-run.js"
import { jobSpecFromDispatch, taskContextStrings, typedValueString } from "./oneshot.js"
import { runOneShot } from "./oneshot-run.js"
import { readMemberEnv } from "./env.js"
import type { SandboxDispatch } from "@zeroroot-ai/sdk"

const memberEnv = readMemberEnv({
  GIBSON_MEMBER_ID: "one-shot",
  GIBSON_BANK_ID: "one-shot",
  GIBSON_CG_JWT: "dispatch-grant",
  GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
})

function dispatch(context: Record<string, unknown> = {}): SandboxDispatch {
  return {
    grant: "dispatch-grant",
    callbackEndpoint: "gibson:50001",
    missionId: "m-1",
    missionRunId: "run-1",
    agentRunId: "ar-1",
    model: "",
    goal: "audit the repo",
    task: { id: "t-1", goal: "audit the repo", context, metadata: {} } as unknown as SandboxDispatch["task"],
    traceId: "",
    spanId: "",
  }
}

test("a parsed TypedValue message decodes, which is what the SDK hands the driver", () => {
  assert.equal(typedValueString({ kind: { case: "stringValue", value: "gitlab/acme" } }), "gitlab/acme")
  assert.equal(typedValueString({ kind: { case: "intValue", value: 42n } }), "42")
  assert.equal(typedValueString({ kind: { case: "boolValue", value: true } }), "true")
  assert.equal(typedValueString({ kind: { case: "nullValue", value: 0 } }), undefined)
  assert.equal(typedValueString({ kind: { case: "bytesValue", value: new Uint8Array([1]) } }), undefined)
})

test("a TypedValue map decodes to strings, and a plain string still reads", () => {
  assert.equal(typedValueString({ stringValue: "gitlab/acme" }), "gitlab/acme")
  assert.equal(typedValueString({ string_value: "snake" }), "snake")
  assert.equal(typedValueString({ intValue: "42" }), "42")
  assert.equal(typedValueString("bare"), "bare")
  assert.equal(typedValueString({ nullValue: null }), undefined, "a null is the absence of a value")
  assert.deepEqual(taskContextStrings({ a: { stringValue: "x" }, b: { nullValue: null } }), { a: "x" })
})

test("a dispatch with only a goal becomes a job with only a goal", () => {
  const spec = jobSpecFromDispatch(dispatch(), memberEnv)
  assert.equal(spec.jobId, "ar-1", "the agent run is the job")
  assert.equal(spec.goal, "audit the repo")
  assert.deepEqual(spec.repositories, [])
  assert.deepEqual(spec.credentialNames, [])
})

test("a dispatch that names a repository becomes a job with one worktree and a deliverable", () => {
  const spec = jobSpecFromDispatch(
    dispatch({
      "repository.url": { stringValue: "https://git.example/acme/api.git" },
      "repository.branch": { stringValue: "develop" },
      "repository.connector": { stringValue: "gitlab/acme" },
      "repository.credential": { stringValue: "acme-token" },
      "repository.deliverable": { stringValue: "MERGE_REQUEST" },
      credentials: { stringValue: "sonar-token" },
      acceptance: { stringValue: "the scanner is clean" },
    }),
    memberEnv,
  )
  assert.equal(spec.repositories.length, 1)
  assert.deepEqual(spec.repositories[0], {
    name: "api",
    connectorRef: "gitlab/acme",
    cloneUrl: "https://git.example/acme/api.git",
    baseBranch: "develop",
    deliverable: "MERGE_REQUEST",
    credentialName: "acme-token",
  })
  assert.deepEqual(spec.credentialNames, ["sonar-token", "acme-token"])
  assert.equal(spec.acceptance, "the scanner is clean")
})

test("an unknown deliverable is NONE, never a guess that pushes", () => {
  const spec = jobSpecFromDispatch(dispatch({ "repository.url": { stringValue: "https://git.example/a/b.git" }, "repository.deliverable": { stringValue: "SHIP_IT" } }), memberEnv)
  assert.equal(spec.repositories[0]!.deliverable, "NONE")
})

/** A spawn seam that answers one turn with the given result. */
function oneTurn(result: Partial<{ isError: boolean; text: string }>) {
  const calls: ClaudeRunOptions[] = []
  const spawn = (o: ClaudeRunOptions): ClaudeHandle => {
    calls.push(o)
    return {
      done: Promise.resolve({
        text: result.text ?? "done",
        sessionId: "sess-1",
        isError: result.isError ?? false,
        resultSubtype: result.isError ? "error_during_execution" : "success",
        numTurns: 2,
        costUsd: 0.3,
        mcpServerErrors: [],
        toolCalls: [],
        events: 5,
        sawResult: true,
        stderr: "",
        exitCode: 0 as number | null,
        signal: null,
      }),
      interrupt: () => {},
      kill: () => {},
      pid: 1,
    }
  }
  return { calls, spawn }
}

const launch = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  GIBSON_CG_JWT: "dispatch-grant",
  GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
  GIBSON_MISSION_ID: "m-1",
  GIBSON_MISSION_RUN_ID: "run-1",
  GIBSON_AGENT_RUN_ID: "ar-1",
  GIBSON_AGENT_TASK_B64: Buffer.from(JSON.stringify({ id: "t-1", goal: "audit the repo" })).toString("base64"),
  ...over,
})

test("a one-shot dispatch runs as one job, closes itself and reports the session and the cost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-oneshot-"))
  try {
    const turn = oneTurn({ text: "two findings recorded" })
    const outcome = await runOneShot({ env: launch({ ZEROCOOL_WORKSPACE: dir, ZEROCOOL_STATE_DIR: join(dir, "state") }), spawn: turn.spawn, claudeCodeVersion: "2.1.257" })
    assert.equal(outcome.jobId, "ar-1")
    assert.equal(outcome.isError, false)
    assert.equal(outcome.claudeSessionId, "sess-1")
    assert.equal(outcome.costUsd, 0.3)
    assert.equal(outcome.turns, 1)
    assert.equal(turn.calls.length, 1, "one dispatch is one turn")
    assert.match(turn.calls[0]!.input!, /audit the repo/)
    assert.match(outcome.text, /two findings recorded/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a failed turn closes the job with a failing verdict and a non-zero outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-oneshot-"))
  try {
    const turn = oneTurn({ isError: true, text: "the model gave up" })
    const outcome = await runOneShot({ env: launch({ ZEROCOOL_WORKSPACE: dir, ZEROCOOL_STATE_DIR: join(dir, "state") }), spawn: turn.spawn, claudeCodeVersion: "2.1.257" })
    assert.equal(outcome.isError, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a launch with no grant or no task is refused, never run with a made-up task", async () => {
  await assert.rejects(runOneShot({ env: { GIBSON_AGENT_TASK_B64: "e30=" }, claudeCodeVersion: "2.1.257" }), /GIBSON_CALLBACK_ENDPOINT is not set|GIBSON_CG_JWT is not set/)
})

test("a task that names a repository needs a credential resolver, and says so", async () => {
  const env = launch({
    GIBSON_AGENT_TASK_B64: Buffer.from(JSON.stringify({ id: "t-1", goal: "fix it", context: { "repository.url": { stringValue: "https://git.example/a/b.git" } } })).toString("base64"),
  })
  await assert.rejects(runOneShot({ env, claudeCodeVersion: "2.1.257" }), /no credential resolver was supplied/)
})
