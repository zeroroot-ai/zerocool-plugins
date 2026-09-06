// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * The Claude Code stream-json events the driver reads.
 *
 * `claude -p --output-format stream-json --verbose` writes one JSON object per
 * line. The shapes below are what version 2.1.257 prints. Real captures live in
 * `test/fixtures/claude-code-<version>/`. The parser is tolerant on purpose: a
 * line that is not JSON is skipped, and an event type this version does not
 * know is kept as `unknown` and never fails the turn (zerocool-plugins#112).
 */

export interface InitEvent {
  kind: "init"
  sessionId: string
  model: string
  claudeCodeVersion: string
  /** `system/init.mcp_servers`, one entry per configured server. */
  mcpServers: { name: string; status: string }[]
  /** Servers the config validation skipped, plus servers that did not connect. */
  mcpServerErrors: string[]
  /** Protocol behaviors this Claude Code implements, e.g. `interrupt_receipt_v1`. */
  capabilities: string[]
  tools: string[]
  permissionMode: string
  /** Where the API key came from, e.g. `ANTHROPIC_API_KEY`. Empty on a subscription login. */
  apiKeySource: string
  plugins: { name: string; path: string }[]
  pluginErrors: string[]
}

export interface ToolUse {
  id: string
  name: string
  input: unknown
}

export interface AssistantEvent {
  kind: "assistant"
  sessionId: string
  text: string
  toolUses: ToolUse[]
  /** Set when a subagent produced the message. */
  parentToolUseId: string | null
}

export interface UserEvent {
  kind: "user"
  sessionId: string
  toolResults: { toolUseId: string; isError: boolean }[]
}

export interface DeltaEvent {
  kind: "delta"
  sessionId: string
  text: string
}

export interface ResultEvent {
  kind: "result"
  /** `success`, `error_max_turns`, `error_during_execution`, ... */
  subtype: string
  sessionId: string
  isError: boolean
  numTurns: number
  costUsd: number
  durationMs: number
  text: string
  permissionDenials: number
}

export interface StatusEvent {
  kind: "status"
  sessionId: string
  status: string
}

export interface ApiRetryEvent {
  kind: "api_retry"
  sessionId: string
  attempt: number
  maxRetries: number
  errorStatus: number | null
  error: string
}

export interface UnknownEvent {
  kind: "unknown"
  type: string
  subtype: string
  sessionId: string
}

export type ClaudeEvent =
  | InitEvent
  | AssistantEvent
  | UserEvent
  | DeltaEvent
  | ResultEvent
  | StatusEvent
  | ApiRetryEvent
  | UnknownEvent

interface RawEvent {
  type?: unknown
  subtype?: unknown
  session_id?: unknown
  uuid?: unknown
  model?: unknown
  claude_code_version?: unknown
  mcp_servers?: unknown
  mcp_server_errors?: unknown
  capabilities?: unknown
  tools?: unknown
  permissionMode?: unknown
  apiKeySource?: unknown
  plugins?: unknown
  plugin_errors?: unknown
  message?: unknown
  parent_tool_use_id?: unknown
  event?: unknown
  result?: unknown
  is_error?: unknown
  num_turns?: unknown
  total_cost_usd?: unknown
  duration_ms?: unknown
  permission_denials?: unknown
  status?: unknown
  attempt?: unknown
  max_retries?: unknown
  error_status?: unknown
  error?: unknown
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})

function parseInit(raw: RawEvent): InitEvent {
  const servers = arr(raw.mcp_servers).map((s) => ({ name: str(rec(s).name), status: str(rec(s).status) }))
  const errors: string[] = []
  for (const e of arr(raw.mcp_server_errors)) {
    const r = rec(e)
    errors.push(`${str(r.name) || "?"}: ${str(r.type)} ${str(r.message)}`.trim())
  }
  for (const s of servers) if (s.status && s.status !== "connected" && s.status !== "pending") errors.push(`${s.name || "?"}: ${s.status}`)
  const pluginErrors: string[] = []
  for (const e of arr(raw.plugin_errors)) {
    const r = rec(e)
    pluginErrors.push(`${str(r.plugin) || "?"}: ${str(r.type)} ${str(r.message)}`.trim())
  }
  return {
    kind: "init",
    sessionId: str(raw.session_id),
    model: str(raw.model),
    claudeCodeVersion: str(raw.claude_code_version),
    mcpServers: servers,
    mcpServerErrors: errors,
    capabilities: arr(raw.capabilities).filter((c): c is string => typeof c === "string"),
    tools: arr(raw.tools).filter((t): t is string => typeof t === "string"),
    permissionMode: str(raw.permissionMode),
    apiKeySource: str(raw.apiKeySource),
    plugins: arr(raw.plugins).map((p) => ({ name: str(rec(p).name), path: str(rec(p).path) })),
    pluginErrors,
  }
}

function parseAssistant(raw: RawEvent): AssistantEvent {
  const chunks: string[] = []
  const toolUses: ToolUse[] = []
  for (const c of arr(rec(raw.message).content)) {
    const block = rec(c)
    if (block.type === "text" && typeof block.text === "string") chunks.push(block.text)
    if (block.type === "tool_use") toolUses.push({ id: str(block.id), name: str(block.name), input: block.input })
  }
  return {
    kind: "assistant",
    sessionId: str(raw.session_id),
    text: chunks.join(""),
    toolUses,
    parentToolUseId: typeof raw.parent_tool_use_id === "string" ? raw.parent_tool_use_id : null,
  }
}

function parseUser(raw: RawEvent): UserEvent {
  const toolResults: UserEvent["toolResults"] = []
  const content = rec(raw.message).content
  for (const c of arr(content)) {
    const block = rec(c)
    if (block.type === "tool_result") toolResults.push({ toolUseId: str(block.tool_use_id), isError: block.is_error === true })
  }
  return { kind: "user", sessionId: str(raw.session_id), toolResults }
}

function parseDelta(raw: RawEvent): DeltaEvent | UnknownEvent {
  const ev = rec(raw.event)
  const delta = rec(ev.delta)
  if (ev.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
    return { kind: "delta", sessionId: str(raw.session_id), text: delta.text }
  }
  return { kind: "unknown", type: "stream_event", subtype: str(ev.type), sessionId: str(raw.session_id) }
}

function parseResult(raw: RawEvent): ResultEvent {
  return {
    kind: "result",
    subtype: str(raw.subtype),
    sessionId: str(raw.session_id),
    isError: raw.is_error === true,
    numTurns: num(raw.num_turns),
    costUsd: num(raw.total_cost_usd),
    durationMs: num(raw.duration_ms),
    text: str(raw.result),
    permissionDenials: arr(raw.permission_denials).length,
  }
}

/** Parse one stdout line. `undefined` when the line is not a JSON object. */
export function parseEventLine(line: string): ClaudeEvent | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return undefined
  let raw: RawEvent
  try {
    raw = JSON.parse(trimmed) as RawEvent
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== "object") return undefined
  const type = str(raw.type)
  const subtype = str(raw.subtype)
  if (type === "system" && subtype === "init") return parseInit(raw)
  if (type === "system" && subtype === "status") return { kind: "status", sessionId: str(raw.session_id), status: str(raw.status) }
  if (type === "system" && subtype === "api_retry") {
    return {
      kind: "api_retry",
      sessionId: str(raw.session_id),
      attempt: num(raw.attempt),
      maxRetries: num(raw.max_retries),
      errorStatus: typeof raw.error_status === "number" ? raw.error_status : null,
      error: str(raw.error),
    }
  }
  if (type === "assistant") return parseAssistant(raw)
  if (type === "user") return parseUser(raw)
  if (type === "stream_event") return parseDelta(raw)
  if (type === "result") return parseResult(raw)
  return { kind: "unknown", type, subtype, sessionId: str(raw.session_id) }
}

/** Split a byte stream into complete lines. The tail waits for its newline. */
export class LineSplitter {
  private buf = ""

  push(chunk: string): string[] {
    this.buf += chunk
    const lines: string[] = []
    let i: number
    while ((i = this.buf.indexOf("\n")) >= 0) {
      lines.push(this.buf.slice(0, i))
      this.buf = this.buf.slice(i + 1)
    }
    return lines
  }

  /** The unterminated tail, once, at end of stream. */
  flush(): string | undefined {
    const rest = this.buf
    this.buf = ""
    return rest.trim() ? rest : undefined
  }
}

/** What one turn produced, reduced from its events. */
export interface TurnSummary {
  text: string
  sessionId: string
  isError: boolean
  /** Empty when the turn ended with a `result`; the reason otherwise. */
  resultSubtype: string
  numTurns: number
  costUsd: number
  mcpServerErrors: string[]
  /** Names of the tools the assistant called, in order. */
  toolCalls: string[]
  events: number
  sawResult: boolean
}

/** Reduce a turn's events. No `result` event means the turn did not finish. */
export function summarizeEvents(events: Iterable<ClaudeEvent>): TurnSummary {
  const out: TurnSummary = {
    text: "",
    sessionId: "",
    isError: false,
    resultSubtype: "",
    numTurns: 0,
    costUsd: 0,
    mcpServerErrors: [],
    toolCalls: [],
    events: 0,
    sawResult: false,
  }
  const chunks: string[] = []
  for (const ev of events) {
    out.events += 1
    if ("sessionId" in ev && ev.sessionId) out.sessionId = ev.sessionId
    switch (ev.kind) {
      case "init":
        out.mcpServerErrors.push(...ev.mcpServerErrors)
        break
      case "assistant":
        if (ev.parentToolUseId === null) {
          if (ev.text) chunks.push(ev.text)
          for (const t of ev.toolUses) out.toolCalls.push(t.name)
        }
        break
      case "result":
        out.sawResult = true
        out.isError = ev.isError
        out.resultSubtype = ev.subtype
        out.numTurns = ev.numTurns
        out.costUsd = ev.costUsd
        if (ev.text) out.text = ev.text
        break
      default:
        break
    }
  }
  if (!out.text) out.text = chunks.join("")
  if (!out.sawResult && out.events > 0) out.isError = true
  return out
}

/** Parse a whole stdout capture. */
export function parseEvents(stdout: string): ClaudeEvent[] {
  const events: ClaudeEvent[] = []
  for (const line of stdout.split("\n")) {
    const ev = parseEventLine(line)
    if (ev) events.push(ev)
  }
  return events
}
