#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { openTaskHarness, type TaskHarness } from "@zeroroot-ai/sdk"
import type { JobSpec as WireJobSpec } from "@zeroroot-ai/sdk/gen/gibson/job/v1/job_pb.js"
import type { Credential } from "@zeroroot-ai/sdk/gen/gibson/harness/v1/harness_callback_pb.js"
import { readMemberEnv, type MemberEnv } from "./env.js"
import type { GitCredential } from "./git.js"
import { ComponentHeartbeat, openComponentClient } from "./heartbeat.js"
import { HarnessInbox, harnessGrants, type SpecOptions } from "./harness-inbox.js"
import { mcpGateway, startMcpServer, type McpServer } from "./mcp.js"
import { FileJobStore, JobTable } from "./job.js"
import { Member } from "./member.js"
import { typedValueString } from "./oneshot.js"
import { assertSubscriptionOnly, readAuthStatus } from "./signin.js"
import { harnessSessionStore } from "./transcript.js"
import { readClaudeVersion } from "./version.js"
import { WorkspaceManager } from "./workspace.js"
import { join } from "node:path"

/**
 * The member bin. The daemon launches this in a long-lived sandbox, one per
 * member of a bank (zerocool-plugins#105, epic decisions 11 and 13).
 *
 * Start: read the member environment, open the harness on the base grant,
 * subscribe to the inbox, heartbeat the member status, and pull queued jobs
 * whenever a slot is free. Stop: SIGTERM interrupts the running turns, the
 * job table is saved, and the process exits.
 */

/** `GIBSON_PLATFORM_URL`, the daemon the heartbeat reaches. */
export const PLATFORM_URL_ENV = "GIBSON_PLATFORM_URL"

/**
 * Where a repository's connector token and base url come from.
 *
 * `RepositorySpec` names a connector and a project, not a url and not a
 * secret. The job spec's `context` map carries the rest, so a bank can serve
 * more than one connector without a rebuild:
 *
 *   `connector.<ref>.base_url`     e.g. `https://gitlab.com`
 *   `connector.<ref>.credential`   the tenant secret name
 *
 * Without an entry the driver falls back to the platform convention: the
 * credential is `<connector name>-connector-cred`, and the base url is
 * GitLab's public host.
 */
export const DEFAULT_CONNECTOR_BASE_URL = "https://gitlab.com"

export function specOptionsFor(defaults: { baseUrl?: string } = {}): SpecOptions {
  const read = (spec: WireJobSpec, key: string): string => typedValueString((spec.context ?? {})[key]) ?? ""
  const connectorName = (ref: string) => ref.split("/").pop() ?? ref
  return {
    credentialFor: (connectorRef, spec) => read(spec, `connector.${connectorRef}.credential`) || `${connectorName(connectorRef)}-connector-cred`,
    baseUrlFor: (connectorRef, spec) => read(spec, `connector.${connectorRef}.base_url`) || defaults.baseUrl || DEFAULT_CONNECTOR_BASE_URL,
  }
}

/**
 * Read a tenant secret out of `GetCredential`.
 *
 * `Credential.secret_data` is a oneof. A git token is stored as an api key, a
 * bearer token, a single-valued custom secret, or basic auth, and basic auth
 * carries the username the token pairs with. Anything else (an OAuth grant)
 * is not a git credential and is refused rather than guessed at.
 *
 * The value is returned to the caller and never logged: the console stream a
 * member writes is shown in a browser.
 */
export function readGitSecret(name: string, credential: Credential | undefined): GitCredential {
  const secret = credential?.secretData
  if (secret?.case === "apiKey" || secret?.case === "bearerToken" || secret?.case === "customSecret") {
    if (secret.value) return { username: "oauth2", token: secret.value }
  }
  if (secret?.case === "basic" && secret.value.password) {
    return { username: secret.value.username || "oauth2", token: secret.value.password }
  }
  throw new Error(
    `GetCredential(${name}) returned no usable git secret. A connector token is stored as an api key, ` +
      "a bearer token, a single-valued custom secret, or basic auth.",
  )
}

/** `GetCredential` under the member base grant. */
export function credentialResolver(harness: TaskHarness): (name: string) => Promise<GitCredential> {
  return async (name: string) => {
    const res = await harness.client.getCredential({ context: harness.context, name })
    if (res.error) throw new Error(`GetCredential(${name}) refused: ${res.error.message}`)
    return readGitSecret(name, res.credential)
  }
}

export interface MemberMainOptions {
  env: NodeJS.ProcessEnv
  log?: (line: string) => void
  onEvent?: (line: string) => void
  /** Test seam. */
  harness?: TaskHarness
}

export async function runMember(opts: MemberMainOptions, signal: AbortSignal): Promise<void> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`[zerocool-claude-member] ${l}\n`))
  const env: MemberEnv = readMemberEnv(opts.env)
  if (env.loginShape === "subscription") assertSubscriptionOnly(opts.env)

  const harness =
    opts.harness ??
    openTaskHarness({ endpoint: env.callbackEndpoint, token: env.baseGrant, insecure: env.callbackInsecure })

  const spec = specOptionsFor({ baseUrl: opts.env.ZEROCOOL_CONNECTOR_BASE_URL ?? "" })
  const inbox = new HarnessInbox({ harness, memberId: env.memberId, spec, log })
  const workspace = new WorkspaceManager({
    root: env.workspace,
    stateDir: env.stateDir,
    capBytes: env.workspaceCapBytes,
    credential: credentialResolver(harness),
    log,
  })
  const table = new JobTable({ cap: env.jobCap, store: new FileJobStore(join(env.stateDir, "jobs.json")) })

  const platformURL = opts.env[PLATFORM_URL_ENV] ?? ""
  if (!platformURL) {
    throw new Error(
      `${PLATFORM_URL_ENV} is not set. The member reports its status on the component heartbeat, ` +
        "and the bank reads that to know whether the member is idle, busy or waiting for a sign-in.",
    )
  }
  const status = new ComponentHeartbeat({
    component: openComponentClient(platformURL, () => harness.token()),
    instanceId: env.memberId,
    log,
  })

  const claudeCodeVersion = await readClaudeVersion(env.claudeBin, opts.env, env.workspace)
  let signedIn = env.loginShape !== "subscription"
  if (!signedIn) {
    signedIn = (await readAuthStatus(env.claudeBin, opts.env, env.workspace)).loggedIn
  }

  // The Gibson MCP server: its own process on a loopback port, holding the
  // member base grant. `ZEROCOOL_MCP_URL` attaches to one that is already
  // running instead of starting a second.
  const running = env.mcpUrl
  const mcp: McpServer | undefined = running
    ? undefined
    : await startMcpServer({
        bin: opts.env.ZEROCOOL_MCP_BIN ?? "gibson-mcp",
        callbackEndpoint: env.callbackEndpoint,
        insecure: env.callbackInsecure,
        env: opts.env,
        cwd: env.workspace,
        log,
      })
  const gateway = mcp ?? mcpGateway(running.replace(/\/mcp$/, ""), { callbackEndpoint: env.callbackEndpoint, insecure: env.callbackInsecure, log })

  const member = new Member({
    env,
    processEnv: opts.env,
    table,
    inbox,
    grants: harnessGrants(harness),
    status,
    workspace,
    claudeCodeVersion,
    mcp: gateway,
    sessions: harnessSessionStore(harness),
    needsSignIn: () => !signedIn,
    ...(opts.onEvent ? { onEvent: (_jobId: string, line: string) => opts.onEvent!(line) } : {}),
    log,
  })

  log(`member ${env.memberId} of bank ${env.bankId}: claude ${claudeCodeVersion || "unknown"}, cap ${env.jobCap}, mcp ${gateway.url}`)
  try {
    await member.run(signal)
  } finally {
    await mcp?.stop()
    harness.stop()
  }
}

async function main(): Promise<void> {
  const controller = new AbortController()
  const stop = (signal: string) => {
    process.stderr.write(`[zerocool-claude-member] ${signal}: finishing the turns in flight\n`)
    controller.abort()
  }
  process.on("SIGTERM", () => stop("SIGTERM"))
  process.on("SIGINT", () => stop("SIGINT"))
  await runMember({ env: process.env, onEvent: (line) => process.stdout.write(`${line}\n`) }, controller.signal)
}

// The bin runs unconditionally; the module is importable for tests.
if (process.argv[1] && process.argv[1].endsWith("member-main.js")) {
  main().catch((e: Error) => {
    process.stderr.write(`[zerocool-claude-member] fatal: ${e.message}\n`)
    process.exit(1)
  })
}
