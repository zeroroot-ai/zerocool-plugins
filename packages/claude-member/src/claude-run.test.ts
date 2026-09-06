// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { claudeArgs, resolveBin, spawnClaude, userMessageLine, type ClaudeRunOptions } from "./claude-run.js"

const FAKE = fileURLToPath(new URL("../test/bin/fake-claude.mjs", import.meta.url))
const fixture = (name: string): string => fileURLToPath(new URL(`../test/fixtures/claude-code-2.1.257/${name}`, import.meta.url))

test("a one-shot run puts the goal on argv and keeps no session file", () => {
  const args = claudeArgs({ goal: "find secrets", cwd: "/w", model: "claude-opus-4-6", maxTurns: 50, maxBudgetUsd: 5, sessionPersistence: false, allowedTools: ["mcp__gibson__*"], mcpServers: { gibson: { command: "node", args: ["/app/dist/server.js"] } } })
  assert.deepEqual(args.slice(0, 2), ["-p", "find secrets"])
  assert.ok(args.includes("--no-session-persistence"))
  assert.ok(args.includes("--dangerously-skip-permissions"))
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json")
  assert.ok(args.includes("--verbose") && args.includes("--include-partial-messages"))
  assert.ok(args.includes("--strict-mcp-config"))
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__gibson__*")
  assert.ok(!args.includes("--input-format"), "a one-shot run reads no stdin")
})

test("a turn reads stream-json on stdin, keeps its session, and resumes it", () => {
  const args = claudeArgs({ input: "next step", cwd: "/w", resume: "sess-1", permissionPromptTool: "mcp__gibson__ask", mcpServers: { gibson: { type: "http", url: "http://127.0.0.1:7455/mcp" } } })
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json")
  assert.equal(args[args.indexOf("--resume") + 1], "sess-1")
  assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "mcp__gibson__ask")
  assert.ok(!args.includes("--no-session-persistence"), "a turn must be resumable")
  const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as { mcpServers: { gibson: { type: string; url: string } } }
  assert.deepEqual(mcp.mcpServers.gibson, { type: "http", url: "http://127.0.0.1:7455/mcp" })
})

test("exactly one of goal and input is set", () => {
  assert.throws(() => claudeArgs({ cwd: "/w" } as ClaudeRunOptions), /exactly one of goal/)
  assert.throws(() => claudeArgs({ cwd: "/w", goal: "a", input: "b" }), /exactly one of goal/)
})

test("the stdin message is one stream-json user message", () => {
  const line = userMessageLine("do the thing")
  assert.ok(line.endsWith("\n"))
  assert.deepEqual(JSON.parse(line) as unknown, { type: "user", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } })
})

test("a .js bin runs under node, anything else is a bin on PATH", () => {
  assert.deepEqual(resolveBin("claude"), { command: "claude", prefix: [] })
  assert.deepEqual(resolveBin("/app/x.js"), { command: process.execPath, prefix: ["/app/x.js"] })
})

test("spawnClaude replays a real capture and reports what the turn produced", async () => {
  const r = await spawnClaude({ input: "hi", cwd: process.cwd(), bin: FAKE, env: { ...process.env, CLAUDE_FAKE_FIXTURE: fixture("job-turn-synthetic.jsonl") } }).done
  assert.equal(r.exitCode, 0)
  assert.equal(r.sawResult, true)
  assert.equal(r.costUsd, 0.4231)
  assert.equal(r.sessionId, "9d3f0f1e-1a4f-4a1e-9d61-2c0a1b2c3d4e")
  assert.deepEqual(r.toolCalls, ["mcp__gibson__ask", "mcp__gibson__submit_finding"])
})

test("the input reaches the child as one stream-json line and stdin then closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-claude-"))
  try {
    const record = join(dir, "calls.jsonl")
    await spawnClaude({ input: "the next input", cwd: dir, bin: FAKE, env: { ...process.env, CLAUDE_FAKE_FIXTURE: fixture("job-turn-synthetic.jsonl"), CLAUDE_FAKE_RECORD: record } }).done
    const call = JSON.parse((await readFile(record, "utf8")).trim()) as { stdin: string; argv: string[] }
    assert.equal(call.stdin, userMessageLine("the next input"))
    assert.ok(call.argv.includes("--input-format"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("every event line reaches the console callback as it arrives", async () => {
  const lines: string[] = []
  await spawnClaude({ input: "hi", cwd: process.cwd(), bin: FAKE, env: { ...process.env, CLAUDE_FAKE_FIXTURE: fixture("job-turn-synthetic.jsonl") }, onEvent: (line) => lines.push(line) }).done
  assert.equal(lines.length, 14)
  assert.equal((JSON.parse(lines[0]!) as { subtype: string }).subtype, "init")
})

test("an interrupt ends the turn with a result, the way SIGINT does", async () => {
  let running!: () => void
  const started = new Promise<void>((r) => (running = r))
  const handle = spawnClaude({ input: "hi", cwd: process.cwd(), bin: FAKE, env: { ...process.env, CLAUDE_FAKE_FIXTURE: fixture("job-turn-synthetic.jsonl"), CLAUDE_FAKE_HANG_MS: "5000" }, onEvent: () => running() })
  await started
  handle.interrupt()
  const r = await handle.done
  assert.equal(r.exitCode, 0)
  assert.equal(r.sawResult, true)
  assert.equal(r.text, "interrupted")
})

test("SIGTERM leaves the turn unfinished with no result, and the driver sees that", async () => {
  let running!: () => void
  const started = new Promise<void>((r) => (running = r))
  const handle = spawnClaude({ input: "hi", cwd: process.cwd(), bin: FAKE, env: { ...process.env, CLAUDE_FAKE_FIXTURE: fixture("interrupted-turn-synthetic.jsonl"), CLAUDE_FAKE_HANG_MS: "5000" }, onEvent: () => running() })
  await started
  handle.kill()
  const r = await handle.done
  assert.equal(r.exitCode, 143)
  assert.equal(r.sawResult, false)
  assert.equal(r.isError, true)
})

test("a missing bin rejects with the bin name instead of hanging", async () => {
  await assert.rejects(spawnClaude({ input: "hi", cwd: process.cwd(), bin: "/nonexistent/claude" }).done, /cannot run \/nonexistent\/claude/)
})
