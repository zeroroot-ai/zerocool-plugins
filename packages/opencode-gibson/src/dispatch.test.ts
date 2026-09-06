// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import {
  decodeTask,
  dispatchChildEnv,
  dispatchTaskKind,
  formatTerminalResult,
  readDispatchContext,
  runDispatch,
  typedValueString,
  type DispatchContext,
} from "./dispatch.js"
import type { OpencodeRunOptions, OpencodeRunResult } from "./opencode-run.js"

/**
 * The sandboxed dispatched shape (zerocool-plugins#57).
 *
 * The property under test throughout: a sandboxed run authenticates with the
 * per-dispatch grant the sandbox injected, and NEVER with a bootstrap token. The
 * grant and the goal are required; a missing one is a launch defect and must
 * fail loudly rather than run opencode with no task or make unauthenticated
 * calls.
 */

// taskB64 renders a gibson.types.v1.Task as the base64 protojson gibson injects
// as GIBSON_AGENT_TASK_B64.
const taskB64 = (goal: string): string =>
  Buffer.from(JSON.stringify({ goal }), "utf8").toString("base64")

const baseEnv = (): NodeJS.ProcessEnv => ({
  GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
  GIBSON_CG_JWT: "task-tok",
  GIBSON_AGENT_TASK_B64: taskB64("audit the login flow"),
})

// ---------------------------------------------------------------------------
// readDispatchContext
// ---------------------------------------------------------------------------

test("readDispatchContext reads the grant, the task and provenance from env", () => {
  const ctx = readDispatchContext(
    {
      ...baseEnv(),
      GIBSON_MISSION_RUN_ID: "mr-1",
      GIBSON_AGENT_RUN_ID: "ar-1",
      GIBSON_TRACE_ID: "tr-1",
      GIBSON_MODEL: "gibson/default",
      GIBSON_TIMEOUT_MS: "60000",
    },
    { cwd: "/srv/work" },
  )
  assert.equal(ctx.callbackEndpoint, "gibson:50001")
  assert.equal(ctx.callbackToken, "task-tok")
  assert.equal(ctx.goal, "audit the login flow")
  assert.equal(ctx.missionRunId, "mr-1")
  assert.equal(ctx.agentRunId, "ar-1")
  assert.equal(ctx.traceId, "tr-1")
  assert.equal(ctx.model, "gibson/default")
  assert.equal(ctx.workspace, "/srv/work")
  assert.equal(ctx.timeoutMs, 60000)
})

test("readDispatchContext needs NO bootstrap token, host key or platform URL", () => {
  // The whole point of the shape: a bootstrap token would reintroduce the
  // enrollment handshake this run exists to avoid. A context that has only the
  // per-dispatch grant is complete.
  const ctx = readDispatchContext(baseEnv(), { cwd: "/w" })
  assert.equal(ctx.callbackToken, "task-tok")
})

test("readDispatchContext ignores a bootstrap token even when one is present", () => {
  // Presence of a stale bootstrap token in the environment must not change how a
  // sandboxed run authenticates — it still uses the per-dispatch grant.
  const ctx = readDispatchContext(
    { ...baseEnv(), GIBSON_BOOTSTRAP_TOKEN: "should-be-ignored" },
    { cwd: "/w" },
  )
  assert.equal(ctx.callbackToken, "task-tok")
  assert.ok(!("bootstrapToken" in ctx))
})

test("readDispatchContext fails when the callback endpoint is missing", () => {
  const env = baseEnv()
  delete env.GIBSON_CALLBACK_ENDPOINT
  assert.throws(() => readDispatchContext(env), /GIBSON_CALLBACK_ENDPOINT is not set/)
})

test("readDispatchContext fails, not falls back, when the token is missing", () => {
  const env = baseEnv()
  delete env.GIBSON_CG_JWT
  assert.throws(() => readDispatchContext(env), /GIBSON_CG_JWT is not/)
})

test("readDispatchContext fails on an empty task goal", () => {
  assert.throws(
    () => readDispatchContext({ ...baseEnv(), GIBSON_AGENT_TASK_B64: taskB64("   ") }),
    /no goal/,
  )
})

test("readDispatchContext fails when the task is missing", () => {
  const env = baseEnv()
  delete env.GIBSON_AGENT_TASK_B64
  assert.throws(() => readDispatchContext(env), /GIBSON_AGENT_TASK_B64 is not set/)
})

test("readDispatchContext fails on an undecodable task", () => {
  assert.throws(
    () => readDispatchContext({ ...baseEnv(), GIBSON_AGENT_TASK_B64: "!!!not-base64-json!!!" }),
    /not valid base64 protojson|no goal/,
  )
})

test("readDispatchContext marks insecure only when explicitly set to 1", () => {
  assert.equal(readDispatchContext(baseEnv(), { cwd: "/w" }).insecure, false)
  assert.equal(
    readDispatchContext({ ...baseEnv(), GIBSON_CALLBACK_INSECURE: "1" }, { cwd: "/w" }).insecure,
    true,
  )
})

// ---------------------------------------------------------------------------
// dispatchChildEnv
// ---------------------------------------------------------------------------

test("dispatchChildEnv hands the child the per-dispatch grant", () => {
  const env = dispatchChildEnv({
    callbackEndpoint: "gibson:50001",
    callbackToken: "tok",
    insecure: true,
    missionRunId: "mr-1",
    agentRunId: "ar-1",
    traceId: "tr-1",
  })
  assert.equal(env.GIBSON_CALLBACK_ENDPOINT, "gibson:50001")
  assert.equal(env.GIBSON_CALLBACK_TOKEN, "tok")
  assert.equal(env.GIBSON_CALLBACK_INSECURE, "1")
  assert.equal(env.GIBSON_MISSION_RUN_ID, "mr-1")
  assert.equal(env.GIBSON_AGENT_RUN_ID, "ar-1")
  assert.equal(env.GIBSON_TRACE_ID, "tr-1")
})

test("dispatchChildEnv omits empty fields rather than setting them blank", () => {
  const env = dispatchChildEnv({ callbackEndpoint: "gibson:50001", callbackToken: "tok" })
  assert.ok(!("GIBSON_MISSION_RUN_ID" in env))
  assert.ok(!("GIBSON_CALLBACK_INSECURE" in env))
})

// ---------------------------------------------------------------------------
// runDispatch
// ---------------------------------------------------------------------------

const fakeRunResult = (over: Partial<OpencodeRunResult> = {}): OpencodeRunResult => ({
  sessionId: "ses_1",
  text: "found nothing",
  finishReason: "stop",
  tokens: { total: 100, input: 80, output: 20, reasoning: 0 },
  cost: 0.25,
  events: 3,
  ...over,
})

const ctx = (over: Partial<DispatchContext> = {}): DispatchContext => ({
  callbackEndpoint: "gibson:50001",
  callbackToken: "tok",
  insecure: false,
  missionRunId: "mr-1",
  agentRunId: "ar-1",
  traceId: "tr-1",
  goal: "do the thing",
  taskContext: {},
  workspace: "/srv/work",
  timeoutMs: 0,
  ...over,
})

test("runDispatch drives opencode with the goal, workspace and the grant env", async () => {
  let seen: OpencodeRunOptions | undefined
  const outcome = await runDispatch(ctx({ model: "gibson/default" }), {
    run: async (opts) => {
      seen = opts
      return fakeRunResult()
    },
  })
  assert.equal(seen?.goal, "do the thing")
  assert.equal(seen?.dir, "/srv/work")
  assert.equal(seen?.model, "gibson/default")
  // The child's callbacks must authenticate as the task — the grant is in its env.
  assert.equal(seen?.env?.GIBSON_CALLBACK_ENDPOINT, "gibson:50001")
  assert.equal(seen?.env?.GIBSON_CALLBACK_TOKEN, "tok")
  assert.equal(outcome.success, true)
  assert.equal(outcome.output, "found nothing")
  assert.equal(outcome.metadata?.opencode_session_id, "ses_1")
  assert.equal(outcome.metadata?.tokens_total, "100")
  assert.equal(outcome.metadata?.finish_reason, "stop")
})

test("runDispatch streams every opencode event live through onEvent", async () => {
  const streamed: string[] = []
  await runDispatch(ctx(), {
    onEvent: (line) => streamed.push(line),
    run: async (opts) => {
      // A real run emits events before it resolves; the driver must forward each.
      opts.onEvent?.('{"type":"text","part":{"type":"text","text":"hi"}}')
      opts.onEvent?.('{"type":"step_finish","part":{"reason":"stop"}}')
      return fakeRunResult()
    },
  })
  assert.deepEqual(streamed, [
    '{"type":"text","part":{"type":"text","text":"hi"}}',
    '{"type":"step_finish","part":{"reason":"stop"}}',
  ])
})

test("runDispatch passes the deadline through only when one was set", async () => {
  let withDeadline: OpencodeRunOptions | undefined
  await runDispatch(ctx({ timeoutMs: 5000 }), {
    run: async (opts) => {
      withDeadline = opts
      return fakeRunResult()
    },
  })
  assert.equal(withDeadline?.timeoutMs, 5000)

  let noDeadline: OpencodeRunOptions | undefined
  await runDispatch(ctx({ timeoutMs: 0 }), {
    run: async (opts) => {
      noDeadline = opts
      return fakeRunResult()
    },
  })
  assert.ok(!("timeoutMs" in (noDeadline ?? {})))
})

test("runDispatch lets a crashed run throw so the caller can fail the dispatch", async () => {
  await assert.rejects(
    () => runDispatch(ctx(), { run: async () => { throw new Error("opencode exited 1") } }),
    /opencode exited 1/,
  )
})

// ---------------------------------------------------------------------------
// formatTerminalResult
// ---------------------------------------------------------------------------

test("formatTerminalResult marks the terminal line apart from the event stream", () => {
  const line = formatTerminalResult({ output: "done", success: true, metadata: { finish_reason: "stop" } })
  const parsed = JSON.parse(line)
  assert.equal(parsed.type, "result")
  assert.equal(parsed.success, true)
  assert.equal(parsed.output, "done")
  assert.equal(parsed.metadata.finish_reason, "stop")
})

test("formatTerminalResult carries a self-reported failure", () => {
  const parsed = JSON.parse(formatTerminalResult({ success: false, output: "goal unreachable" }))
  assert.equal(parsed.success, false)
  assert.equal(parsed.output, "goal unreachable")
})

// ---------------------------------------------------------------------------
// Task.context is TypedValue, not string (zerocool-plugins#88)
// ---------------------------------------------------------------------------

/**
 * `Task.context` and `Task.metadata` are `map<string, gibson.common.v1.TypedValue>`.
 * gibson dispatches with `protojson.Marshal(agent.TaskToProto(task))`, whose
 * `mapToTypedValueMap` wraps every entry, so the bytes a sandboxed agent decodes
 * carry `{"stringValue":"..."}` and never a bare string. Reading these maps as
 * plain strings dropped every entry: no `zerocool.task` selector, no
 * `repository.commit`, no `target.id` ever reached a dispatched run.
 */
const wholeTaskB64 = (task: unknown): string => Buffer.from(JSON.stringify(task), "utf8").toString("base64")

test("a Task context marshalled by gibson decodes to strings", () => {
  const decoded = decodeTask(
    wholeTaskB64({
      goal: "scan the portal",
      context: {
        "zerocool.task": { stringValue: "source-analysis" },
        "repository.commit": { stringValue: "cafebabe" },
        "pipeline.id": { intValue: "41" },
        "watch.enabled": { boolValue: true },
        "score.ratio": { doubleValue: 0.5 },
        "target.id": { nullValue: "NULL_VALUE" },
      },
    }),
  )

  assert.equal(decoded.context["zerocool.task"], "source-analysis")
  assert.equal(decoded.context["repository.commit"], "cafebabe")
  assert.equal(decoded.context["pipeline.id"], "41", "protojson renders int64 as a string")
  assert.equal(decoded.context["watch.enabled"], "true")
  assert.equal(decoded.context["score.ratio"], "0.5")
  assert.ok(
    !("target.id" in decoded.context),
    "a null is the absence of a value; rendering it would give a task the target id \"null\"",
  )
})

test("the task kind selector works off a real dispatched Task", () => {
  const decoded = decodeTask(wholeTaskB64({ goal: "watch", context: { "zerocool.task": { stringValue: "watch" } } }))
  assert.equal(dispatchTaskKind({ taskContext: decoded.context }), "watch")
})

test("a hand-built Task with plain strings still decodes", () => {
  const decoded = decodeTask(wholeTaskB64({ goal: "g", context: { "zerocool.task": "source-analysis" } }))
  assert.equal(decoded.context["zerocool.task"], "source-analysis")
})

test("typedValueString reads both protojson spellings and refuses the rest", () => {
  assert.equal(typedValueString({ stringValue: "a" }), "a")
  assert.equal(typedValueString({ string_value: "a" }), "a", "protojson can be told to keep proto field names")
  assert.equal(typedValueString({ int_value: "7" }), "7")
  assert.equal(typedValueString("bare"), "bare")
  assert.equal(typedValueString({ nullValue: "NULL_VALUE" }), undefined)
  assert.equal(typedValueString({ listValue: [] }), undefined)
  assert.equal(typedValueString(undefined), undefined)
  assert.equal(typedValueString(42), undefined)
})
