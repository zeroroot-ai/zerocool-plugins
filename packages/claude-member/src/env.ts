// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The environment contract of a member sandbox (zerocool-plugins#105).
 *
 * gibson launches the member image with these variables. The driver reads
 * them once at start and fails on a missing required one: a member with no
 * bank or no grant has nothing to serve, and guessing would report a made-up
 * status as the bank's.
 *
 * Names starting with `GIBSON_` come from the daemon. Names starting with
 * `ZEROCOOL_` are this image's own knobs, set in the manifest (gibson#1717).
 */
export const MEMBER_ENV = {
  /** The member this sandbox serves. Required in member mode. */
  memberId: "GIBSON_MEMBER_ID",
  /** The bank the member belongs to. Required in member mode. */
  bankId: "GIBSON_BANK_ID",
  /** The member base grant. Callbacks that are not a turn use it. Required. */
  baseGrant: "GIBSON_CG_JWT",
  /** The harness callback endpoint, `host:port` or a URL. Required. */
  callbackEndpoint: "GIBSON_CALLBACK_ENDPOINT",
  /** Dial the callback endpoint without TLS. Only for a local or kind daemon. */
  callbackInsecure: "GIBSON_CALLBACK_INSECURE",
  /** `member` (always-on) or `one-shot` (one dispatch, one auto-closed job). */
  instanceMode: "GIBSON_INSTANCE_MODE",
  /** The mission the member was originated under (ADR-0063). */
  missionId: "GIBSON_MISSION_ID",
  /** `api-key`, `subscription`, `bedrock`, `vertex` or `foundry`. */
  loginShape: "ZEROCOOL_LOGIN_SHAPE",
  /** The model passed as `--model`. Empty leaves it to Claude Code. */
  model: "ZEROCOOL_CLAUDE_MODEL",
  /** Jobs-in-flight cap. Default 1. */
  jobCap: "ZEROCOOL_JOB_CAP",
  /** The workspace root. Default `/workspace`. */
  workspace: "ZEROCOOL_WORKSPACE",
  /** Clone cache cap in bytes. Default 20 GiB. */
  workspaceCapBytes: "ZEROCOOL_WORKSPACE_CAP_BYTES",
  /** The driver's state directory. Default `~/.zerocool`. */
  stateDir: "ZEROCOOL_STATE_DIR",
  /** The `claude` bin. A `.js` path runs under node. Default `claude`. */
  claudeBin: "ZEROCOOL_CLAUDE_BIN",
  /** `--max-turns` per turn. Default 200. */
  maxTurns: "ZEROCOOL_CLAUDE_MAX_TURNS",
  /** `--max-budget-usd` per turn. Unset means no cap. */
  maxBudgetUsd: "ZEROCOOL_CLAUDE_MAX_BUDGET_USD",
  /** The localhost Gibson MCP server URL the turns attach to (#108). */
  mcpUrl: "ZEROCOOL_MCP_URL",
  /** Idle time after which a waiting job closes as `abandoned`, ms. Default 24h. */
  staleLimitMs: "ZEROCOOL_JOB_STALE_LIMIT_MS",
  /** Heartbeat cadence, ms. Default 30s. */
  heartbeatMs: "ZEROCOOL_HEARTBEAT_MS",
  /** Claude Code's own config dir. Per member, inside the sandbox. */
  claudeConfigDir: "CLAUDE_CONFIG_DIR",
} as const

export type InstanceMode = "member" | "one-shot"
export type LoginShape = "api-key" | "subscription" | "bedrock" | "vertex" | "foundry"

export interface MemberEnv {
  memberId: string
  bankId: string
  baseGrant: string
  callbackEndpoint: string
  callbackInsecure: boolean
  instanceMode: InstanceMode
  missionId: string
  loginShape: LoginShape
  model: string
  jobCap: number
  workspace: string
  workspaceCapBytes: number
  stateDir: string
  claudeBin: string
  maxTurns: number
  maxBudgetUsd: number | undefined
  mcpUrl: string
  staleLimitMs: number
  heartbeatMs: number
  claudeConfigDir: string
}

const LOGIN_SHAPES: readonly LoginShape[] = ["api-key", "subscription", "bedrock", "vertex", "foundry"]

function required(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const v = env[name]
  if (!v) throw new Error(`${name} is not set. ${why}`)
  return v
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const raw = env[name]
  if (raw === undefined || raw === "") return dflt
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  return n
}

/** Read and validate the member contract. */
export function readMemberEnv(env: NodeJS.ProcessEnv): MemberEnv {
  const modeRaw = env[MEMBER_ENV.instanceMode] ?? "member"
  if (modeRaw !== "member" && modeRaw !== "one-shot") {
    throw new Error(`${MEMBER_ENV.instanceMode} must be member or one-shot, got ${JSON.stringify(modeRaw)}`)
  }
  const shapeRaw = env[MEMBER_ENV.loginShape] ?? "api-key"
  if (!LOGIN_SHAPES.includes(shapeRaw as LoginShape)) {
    throw new Error(`${MEMBER_ENV.loginShape} must be one of ${LOGIN_SHAPES.join(", ")}, got ${JSON.stringify(shapeRaw)}`)
  }
  const stateDir = env[MEMBER_ENV.stateDir] ?? join(homedir(), ".zerocool")
  const budget = env[MEMBER_ENV.maxBudgetUsd]
  return {
    memberId: required(env, MEMBER_ENV.memberId, "A member sandbox is launched for one bank member."),
    bankId: required(env, MEMBER_ENV.bankId, "A member sandbox belongs to one bank."),
    baseGrant: required(env, MEMBER_ENV.baseGrant, "The member base grant is the only credential of this sandbox (ADR-0045)."),
    callbackEndpoint: required(env, MEMBER_ENV.callbackEndpoint, "The inbox and the callbacks are reached through it."),
    callbackInsecure: env[MEMBER_ENV.callbackInsecure] === "1",
    instanceMode: modeRaw,
    missionId: env[MEMBER_ENV.missionId] ?? "",
    loginShape: shapeRaw as LoginShape,
    model: env[MEMBER_ENV.model] ?? "",
    jobCap: positiveInt(env, MEMBER_ENV.jobCap, 1),
    workspace: env[MEMBER_ENV.workspace] ?? "/workspace",
    workspaceCapBytes: positiveInt(env, MEMBER_ENV.workspaceCapBytes, 20 * 1024 * 1024 * 1024),
    stateDir,
    claudeBin: env[MEMBER_ENV.claudeBin] ?? "claude",
    maxTurns: positiveInt(env, MEMBER_ENV.maxTurns, 200),
    maxBudgetUsd: budget ? Number(budget) : undefined,
    mcpUrl: env[MEMBER_ENV.mcpUrl] ?? "",
    staleLimitMs: positiveInt(env, MEMBER_ENV.staleLimitMs, 24 * 60 * 60 * 1000),
    heartbeatMs: positiveInt(env, MEMBER_ENV.heartbeatMs, 30_000),
    claudeConfigDir: env[MEMBER_ENV.claudeConfigDir] ?? join(stateDir, "claude-config"),
  }
}

/**
 * Environment prefixes a Claude Code child may see. Everything else is dropped,
 * so no `GIBSON_*` grant, no `ZEROCOOL_*` knob and no git token reaches the
 * model's process. The provider credential passes through because Claude Code
 * itself reads it (ADR-0008, the hosting terms).
 */
const CHILD_ENV_ALLOW: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_",
  "TZ",
  "TERM",
  "TMPDIR",
  "NODE_",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_",
  "CLAUDE_",
  "ANTHROPIC_",
  "AWS_",
  "GOOGLE_",
  "CLOUD_ML_REGION",
  "AZURE_",
  "MCP_TIMEOUT",
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
]

const CHILD_ENV_DENY: readonly string[] = ["GIBSON_", "ZEROCOOL_", "GIT_"]

/** The environment a Claude Code child gets: the allow list above, plus fixed values. */
export function claudeChildEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (CHILD_ENV_DENY.some((p) => k.startsWith(p))) continue
    if (!CHILD_ENV_ALLOW.some((p) => k === p || k.startsWith(p))) continue
    out[k] = v
  }
  // Auto memory would write facts learned on one job into a store the next,
  // unrelated job reads (glossary, Job: unrelated jobs never share a conversation).
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1"
  return { ...out, ...extra }
}
