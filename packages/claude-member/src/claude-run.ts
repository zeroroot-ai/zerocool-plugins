// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { spawn, type ChildProcess } from "node:child_process"
import { LineSplitter, parseEventLine, summarizeEvents, type ClaudeEvent, type TurnSummary } from "./events.js"

/**
 * Run the unmodified `claude` CLI headless (ADR-0008 decision 4).
 *
 * Two shapes share one argv builder:
 *
 *  - **one-shot**: the goal on argv (`-p <goal>`), no stdin, no session file.
 *    The one-shot dispatch of gibson#1621 (`oneshot-run.ts`).
 *  - **turn**: `-p --input-format stream-json`, the input written to stdin as
 *    one user message, the session kept on disk so the next turn can
 *    `--resume` it. The member driver (`turn.ts`).
 *
 * Both stream NDJSON on stdout (`events.ts`). The credential comes from the
 * environment: `ANTHROPIC_API_KEY`, a cloud provider's variables, or the
 * subscription login inside `CLAUDE_CONFIG_DIR`. This module never reads it.
 */
export interface McpServerSpec {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: "stdio" | "http" | "sse"
  url?: string
  headers?: Record<string, string>
}

export interface ClaudeRunOptions {
  /** The prompt on argv. Exactly one of `goal` and `input` is set. */
  goal?: string
  /** The user message written to stdin as stream-json. */
  input?: string
  cwd: string
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  appendSystemPrompt?: string
  /** MCP servers as `--mcp-config` JSON, with `--strict-mcp-config`. */
  mcpServers?: Record<string, McpServerSpec>
  /** Tool patterns that run without a prompt, e.g. "mcp__gibson__*". */
  allowedTools?: string[]
  /** The MCP tool that answers permission prompts, e.g. `mcp__gibson__ask`. */
  permissionPromptTool?: string
  /** Continue this Claude Code session. Omitted on the first turn. */
  resume?: string
  /** One-shot runs keep no session file. Turns need one for `--resume`. */
  sessionPersistence?: boolean
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  bin?: string
  onEvent?: (line: string, event: ClaudeEvent | undefined) => void
}

export interface ClaudeRunResult extends TurnSummary {
  /** What the CLI wrote to stderr: startup warnings, and the failure reason. */
  stderr: string
  exitCode: number | null
  /** The signal that ended the process, when one did. */
  signal: NodeJS.Signals | null
}

/** A running turn. `done` settles when the process exits. */
export interface ClaudeHandle {
  done: Promise<ClaudeRunResult>
  /**
   * End the turn cleanly: Claude Code records a `result` on SIGINT and exits
   * 0. SIGTERM leaves the turn unfinished with no result (exit 143).
   */
  interrupt(): void
  kill(): void
  pid: number | undefined
}

/** Build the argv for one headless run. */
export function claudeArgs(opts: ClaudeRunOptions): string[] {
  if ((opts.goal === undefined) === (opts.input === undefined)) {
    throw new Error("claudeArgs: set exactly one of goal (argv prompt) and input (stream-json on stdin)")
  }
  const args = ["-p"]
  if (opts.goal !== undefined) args.push(opts.goal)
  else args.push("--input-format", "stream-json")
  args.push("--output-format", "stream-json", "--verbose", "--include-partial-messages")
  if (opts.sessionPersistence === false) args.push("--no-session-persistence")
  // The gVisor sandbox and the per-turn grant are the controls (glossary,
  // Permission posture). Claude Code refuses this flag as root, so the image
  // runs as an unprivileged user.
  args.push("--dangerously-skip-permissions")
  if (opts.resume) args.push("--resume", opts.resume)
  if (opts.model) args.push("--model", opts.model)
  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns))
  if (opts.maxBudgetUsd) args.push("--max-budget-usd", String(opts.maxBudgetUsd))
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt)
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    args.push("--mcp-config", JSON.stringify({ mcpServers: opts.mcpServers }), "--strict-mcp-config")
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) args.push("--allowedTools", opts.allowedTools.join(","))
  if (opts.permissionPromptTool) args.push("--permission-prompt-tool", opts.permissionPromptTool)
  return args
}

/** One stream-json user message, as Claude Code reads it on stdin. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`
}

/** Parse the NDJSON stream into the run result. */
export function parseClaudeEvents(stdout: string): TurnSummary {
  const events: ClaudeEvent[] = []
  for (const line of stdout.split("\n")) {
    const ev = parseEventLine(line)
    if (ev) events.push(ev)
  }
  return summarizeEvents(events)
}

/** A `.js` bin runs under node; anything else is a bin on PATH. */
export function resolveBin(bin: string): { command: string; prefix: string[] } {
  return bin.endsWith(".js") ? { command: process.execPath, prefix: [bin] } : { command: bin, prefix: [] }
}

/** Spawn claude and stream its events. The handle's `done` never rejects on a non-zero exit. */
export function spawnClaude(opts: ClaudeRunOptions): ClaudeHandle {
  const bin = opts.bin ?? opts.env?.ZEROCOOL_CLAUDE_BIN ?? process.env.ZEROCOOL_CLAUDE_BIN ?? "claude"
  const { command, prefix } = resolveBin(bin)
  const args = [...prefix, ...claudeArgs(opts)]
  const env = opts.env ?? process.env
  const child: ChildProcess = spawn(command, args, { cwd: opts.cwd, env, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] })
  const events: ClaudeEvent[] = []
  const err: string[] = []
  const splitter = new LineSplitter()
  const take = (line: string) => {
    if (!line.trim()) return
    const ev = parseEventLine(line)
    if (ev) events.push(ev)
    if (opts.onEvent) opts.onEvent(line, ev)
  }
  if (opts.input !== undefined && child.stdin) {
    child.stdin.on("error", () => {})
    child.stdin.end(userMessageLine(opts.input))
  }
  child.stdout?.on("data", (d: Buffer) => {
    for (const line of splitter.push(d.toString())) take(line)
  })
  child.stderr?.on("data", (d: Buffer) => err.push(d.toString()))

  let timer: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<ClaudeRunResult>((resolve, reject) => {
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => child.kill("SIGINT"), opts.timeoutMs)
    }
    child.on("error", (e) => {
      if (timer) clearTimeout(timer)
      reject(new Error(`cannot run ${bin}: ${e.message}`))
    })
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer)
      const tail = splitter.flush()
      if (tail) take(tail)
      const summary = summarizeEvents(events)
      const stderr = err.join("").trim()
      if (!summary.sawResult && stderr && !summary.text) summary.text = stderr.slice(0, 2000)
      resolve({ ...summary, stderr: stderr.slice(0, 4000), exitCode: code, signal })
    })
  })
  return {
    done,
    interrupt: () => child.kill("SIGINT"),
    kill: () => child.kill("SIGTERM"),
    pid: child.pid,
  }
}

/** Run to completion. Rejects on a non-zero exit or a turn with no result. */
export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const r = await spawnClaude(opts).done
  if (r.exitCode !== 0) {
    throw new Error(`claude exited ${r.exitCode ?? r.signal}: ${(r.text || "no output").slice(0, 2000)}`)
  }
  return r
}
