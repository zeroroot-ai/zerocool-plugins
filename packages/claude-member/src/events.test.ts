// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { LineSplitter, parseEventLine, parseEvents, summarizeEvents, type InitEvent, type ResultEvent } from "./events.js"

/**
 * The fixtures are what Claude Code 2.1.257 really printed, or, where a paid
 * key was needed to produce an event, a file built from those real shapes and
 * marked `synthetic-until-captured` (test/fixtures/README.md). A hand-written
 * fixture is how a parser passes its own tests and still fails against the
 * tool it parses, so the field set below comes from the real capture.
 */
const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../test/fixtures/claude-code-2.1.257/${name}`, import.meta.url)), "utf8")

test("the real capture: system/init carries the session, the model, the MCP servers and the capabilities", () => {
  const events = parseEvents(fixture("auth-error-real.jsonl"))
  const init = events[0] as InitEvent
  assert.equal(init.kind, "init")
  assert.equal(init.claudeCodeVersion, "2.1.257")
  assert.equal(init.permissionMode, "bypassPermissions")
  assert.equal(init.apiKeySource, "ANTHROPIC_API_KEY")
  assert.deepEqual(init.mcpServers, [{ name: "gibson", status: "failed" }])
  assert.deepEqual(init.mcpServerErrors, ["gibson: failed"], "a server that did not connect is an init error")
  assert.ok(init.capabilities.includes("interrupt_receipt_v1"), "capabilities feature-detect the protocol")
  assert.ok(init.sessionId.length > 0)
})

test("the real capture: api_retry and the failed result are read, not guessed", () => {
  const events = parseEvents(fixture("auth-error-real.jsonl"))
  const retries = events.filter((e) => e.kind === "api_retry")
  assert.equal(retries.length, 10)
  assert.equal(retries[0]!.kind === "api_retry" && retries[0]!.errorStatus, 401)
  assert.equal(retries[0]!.kind === "api_retry" && retries[0]!.error, "authentication_failed")

  const summary = summarizeEvents(events)
  assert.equal(summary.sawResult, true)
  assert.equal(summary.isError, true, "is_error is true even though subtype is success")
  assert.equal(summary.resultSubtype, "success")
  assert.equal(summary.numTurns, 1)
  assert.equal(summary.costUsd, 0)
  assert.match(summary.text, /401 API key is invalid/)
})

test("a full turn: text, tool calls, cost, and the session id", () => {
  const summary = summarizeEvents(parseEvents(fixture("job-turn-synthetic.jsonl")))
  assert.equal(summary.sawResult, true)
  assert.equal(summary.isError, false)
  assert.equal(summary.numTurns, 4)
  assert.equal(summary.costUsd, 0.4231)
  assert.equal(summary.sessionId, "9d3f0f1e-1a4f-4a1e-9d61-2c0a1b2c3d4e")
  assert.deepEqual(summary.toolCalls, ["mcp__gibson__ask", "mcp__gibson__submit_finding"])
  assert.equal(summary.text, "One finding recorded on the job branch.")
  assert.deepEqual(summary.mcpServerErrors, [], "a connected server raises nothing")
})

test("subagent text never reaches the job's own text", () => {
  const events = parseEvents(fixture("job-turn-synthetic.jsonl")).filter((e) => e.kind !== "result")
  const summary = summarizeEvents(events)
  assert.ok(!summary.text.includes("subagent chatter"), "parent_tool_use_id marks a subagent message")
})

test("an interrupted turn has no result event, so the turn did not finish", () => {
  const summary = summarizeEvents(parseEvents(fixture("interrupted-turn-synthetic.jsonl")))
  assert.equal(summary.sawResult, false)
  assert.equal(summary.isError, true)
  assert.equal(summary.text, "Reading the handler.", "the partial assistant text survives")
})

test("an event type this version does not know is skipped, never fatal", () => {
  const unknown = parseEventLine(JSON.stringify({ type: "invented_in_a_later_release", session_id: "s" }))
  assert.equal(unknown?.kind, "unknown")
  assert.equal(unknown?.kind === "unknown" && unknown.type, "invented_in_a_later_release")
  const summary = summarizeEvents(parseEvents(fixture("job-turn-synthetic.jsonl")))
  assert.equal(summary.isError, false, "the unknown event in the fixture did not fail the turn")
})

test("a non-JSON line is skipped rather than counted", () => {
  assert.equal(parseEventLine("INFO something claude printed"), undefined)
  assert.equal(parseEventLine(""), undefined)
  assert.equal(parseEventLine("{not json"), undefined)
  assert.equal(parseEvents("not json\nalso not json").length, 0)
})

test("an empty stream is distinguishable from an unfinished one", () => {
  const empty = summarizeEvents([])
  assert.equal(empty.events, 0)
  assert.equal(empty.isError, false, "no events at all is not a failed turn")
})

test("stream_event deltas carry the streamed text, other stream events do not", () => {
  const delta = parseEventLine(JSON.stringify({ type: "stream_event", session_id: "s", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }))
  assert.equal(delta?.kind, "delta")
  const start = parseEventLine(JSON.stringify({ type: "stream_event", session_id: "s", event: { type: "message_start" } }))
  assert.equal(start?.kind, "unknown")
})

test("the result event's fields are read by name, with a missing field defaulting", () => {
  const r = parseEventLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s" })) as ResultEvent
  assert.equal(r.kind, "result")
  assert.equal(r.subtype, "error_max_turns")
  assert.equal(r.numTurns, 0)
  assert.equal(r.costUsd, 0)
  assert.equal(r.text, "")
})

test("LineSplitter holds a partial line until its newline arrives", () => {
  const s = new LineSplitter()
  assert.deepEqual(s.push('{"a":'), [])
  assert.deepEqual(s.push('1}\n{"b":2}'), ['{"a":1}'])
  assert.equal(s.flush(), '{"b":2}')
  assert.equal(s.flush(), undefined)
})
