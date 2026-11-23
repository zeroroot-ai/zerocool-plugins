#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { callbackBaseUrl, openTaskHarness, type TaskHarness } from "@zeroroot-ai/sdk"
import { ensureStateDir, readMemberEnv, type MemberEnv } from "./env.js"
import { harnessToolCaller } from "./connector-tools.js"
import { ComponentHeartbeat, openComponentClient } from "./heartbeat.js"
import { HarnessInbox, harnessGrants } from "./harness-inbox.js"
import { assertTurnRequiresToken, mcpGateway, startMcpServer, TURN_TOKEN_ENV, type McpServer } from "./mcp.js"
import { FileJobStore, JobTable } from "./job.js"
import { assertSingleJob, Member } from "./member.js"
import { childEnv, platformTransport, platformTrust, type PlatformTrust } from "./platform-ca.js"
import { assertSubscriptionOnly, consoleRelay, readAuthStatus, SignIn } from "./signin.js"
import { harnessSessionStore } from "./transcript.js"
import { readClaudeVersion } from "./version.js"
import { WorkspaceManager } from "./workspace.js"
import { startWorkspaceMcp } from "./workspace-mcp.js"
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
 * The harness on the member base grant. The transport is built here rather
 * than in the SDK, so the platform CA reaches it. The grant interceptor reads
 * the harness's current token, so a renewal takes effect on the next call.
 */
export function openHarness(env: MemberEnv, trust: PlatformTrust | undefined, grant: string = env.baseGrant): TaskHarness {
  let harness: TaskHarness | undefined
  const transport = platformTransport(callbackBaseUrl(env.callbackEndpoint, env.callbackInsecure), () => harness?.token() ?? grant, trust)
  harness = openTaskHarness({ endpoint: env.callbackEndpoint, token: grant, insecure: env.callbackInsecure, transport })
  return harness
}

/** The connector tool caller. Each call carries the grant of its turn, never a forge credential. */
export function toolCallerFor(env: MemberEnv, trust: PlatformTrust | undefined): ReturnType<typeof harnessToolCaller> {
  return harnessToolCaller((grant) => openHarness(env, trust, grant))
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
  assertSingleJob(env.jobCap)
  await ensureStateDir(env.stateDir)

  // The platform CA, when the edge chains to a private root. Every transport
  // below trusts it, and every child gets the file, never the PEM.
  const trust = await platformTrust(opts.env, env.stateDir)
  if (trust) log(`platform CA: ${trust.file}, trusted beside the public roots`)
  const processEnv = childEnv(opts.env, trust)

  const harness = opts.harness ?? openHarness(env, trust)

  const inbox = new HarnessInbox({ harness, memberId: env.memberId, log })
  const workspace = new WorkspaceManager({ root: env.workspace, stateDir: env.stateDir, tools: toolCallerFor(env, trust), log })
  const table = new JobTable({ cap: env.jobCap, store: new FileJobStore(join(env.stateDir, "jobs.json")) })

  const platformURL = opts.env[PLATFORM_URL_ENV] ?? ""
  if (!platformURL) {
    throw new Error(
      `${PLATFORM_URL_ENV} is not set. The member reports its status on the component heartbeat, ` +
        "and the bank reads that to know whether the member is idle, busy or waiting for a sign-in.",
    )
  }
  const status = new ComponentHeartbeat({
    component: openComponentClient(platformURL, () => harness.token(), trust),
    instanceId: env.memberId,
    log,
  })

  const claudeCodeVersion = await readClaudeVersion(env.claudeBin, processEnv, env.workspace)
  let signedIn = env.loginShape !== "subscription"
  if (!signedIn) {
    signedIn = (await readAuthStatus(env.claudeBin, processEnv, env.workspace)).loggedIn
  }

  // The Gibson MCP server: its own process on a loopback port, holding the
  // member base grant. `ZEROCOOL_MCP_URL` attaches to one that is already
  // running instead of starting a second; whoever started it shares its
  // /turn bearer token through GIBSON_TURN_TOKEN, and the server has to
  // refuse an unauthenticated POST /turn just like one the driver starts.
  const running = env.mcpUrl
  if (running && !opts.env[TURN_TOKEN_ENV]) {
    throw new Error(
      `${TURN_TOKEN_ENV} is not set. ZEROCOOL_MCP_URL attaches to a running Gibson MCP server, and its /turn ` +
        "control plane is called only with the bearer token that server was started with.",
    )
  }
  if (running) await assertTurnRequiresToken(running.replace(/\/mcp$/, ""))
  const mcp: McpServer | undefined = running
    ? undefined
    : await startMcpServer({
        bin: opts.env.ZEROCOOL_MCP_BIN ?? "gibson-mcp",
        callbackEndpoint: env.callbackEndpoint,
        insecure: env.callbackInsecure,
        env: processEnv,
        cwd: env.workspace,
        log,
      })
  const gateway = mcp ?? mcpGateway(running.replace(/\/mcp$/, ""), { token: opts.env[TURN_TOKEN_ENV]!, callbackEndpoint: env.callbackEndpoint, insecure: env.callbackInsecure, log })

  const workspaceMcp = await startWorkspaceMcp()
  const member = new Member({
    env,
    processEnv,
    table,
    inbox,
    grants: harnessGrants(harness),
    status,
    workspace,
    workspaceMcp,
    claudeCodeVersion,
    mcp: gateway,
    sessions: harnessSessionStore(harness),
    needsSignIn: () => !signedIn,
    ...(env.loginShape === "subscription"
      ? {
          signIn: () =>
            new SignIn({
              bin: env.claudeBin,
              env: processEnv,
              cwd: env.workspace,
              relay: consoleRelay(
                (line) => opts.onEvent?.(JSON.stringify(line)),
                () => {
                  signedIn = true
                },
              ),
              log,
            }),
        }
      : {}),
    ...(opts.onEvent ? { onEvent: (_jobId: string, line: string) => opts.onEvent!(line) } : {}),
    log,
  })

  log(`member ${env.memberId} of bank ${env.bankId}: claude ${claudeCodeVersion || "unknown"}, cap ${env.jobCap}, mcp ${gateway.url}`)
  try {
    await member.run(signal)
  } finally {
    await mcp?.stop()
    await workspaceMcp.stop()
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
