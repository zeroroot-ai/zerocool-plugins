// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { parkAfterResult, Watcher } from "@zeroroot-ai/sdk"
import { ensureStateDir, MEMBER_ENV, readMemberEnv, type MemberEnv } from "./env.js"
import type { ClaudeEvent } from "./events.js"
import type { McpGateway } from "./inbox.js"
import { type ToolCaller } from "./connector-tools.js"
import { JobTable, MemoryJobStore } from "./job.js"
import { toolCallerFor } from "./member-main.js"
import { Member } from "./member.js"
import { dispatchGrants, jobSpecFromDispatch, OneShotInbox, OneShotStatus, oneShotMemberEnv, readDispatch, type OneShotOutcome } from "./oneshot.js"
import { childEnv, platformTrust } from "./platform-ca.js"
import { readClaudeVersion } from "./version.js"
import { WorkspaceManager } from "./workspace.js"

/**
 * Run one dispatched Task as a single auto-closed job (zerocool-plugins#111).
 *
 * The launch supplies the task, the per-dispatch grant and the callback
 * endpoint (ADR-0116). That grant is both the member base grant and the
 * turn grant, because a one-shot run has exactly one dispatch. The turn runner,
 * the job table and the workspace manager are the member's, unchanged.
 */
export interface OneShotOptions {
  env: NodeJS.ProcessEnv
  /** Every stream-json line, for the live console. */
  onEvent?: (line: string, event: ClaudeEvent | undefined) => void
  log?: (line: string) => void
  /** Calls a connector tool under the dispatch grant. The default calls it through the harness. */
  tools?: ToolCaller
  mcp?: McpGateway
  claudeCodeVersion?: string
  /** Test seam: the spawn used for each turn. */
  spawn?: ConstructorParameters<typeof Member>[0]["spawn"]
}

export async function runOneShot(opts: OneShotOptions): Promise<OneShotOutcome> {
  const dispatch = readDispatch(opts.env)
  const env: MemberEnv = oneShotMemberEnv(dispatch, opts.env, readMemberEnv)
  const spec = jobSpecFromDispatch(dispatch, env)
  const grants = dispatchGrants(dispatch.grant)
  const inbox = new OneShotInbox(spec, dispatch.grant, `mission:${dispatch.missionId || "-"}`)
  const log = opts.log ?? (() => {})
  await ensureStateDir(env.stateDir)
  // The Claude child verifies the platform edge against the same CA the
  // member shape hands out. The PEM itself stays in the driver.
  const trust = await platformTrust(opts.env, env.stateDir)
  const processEnv = childEnv(opts.env, trust)
  const workspace = new WorkspaceManager({ root: env.workspace, tools: opts.tools ?? toolCallerFor(env, trust), log })

  // A one-shot sandbox is torn down after the run and nothing resumes it, so
  // the table lives in memory. A member persists its table; this shape has
  // nothing to come back to.
  const table = new JobTable({ cap: 1, store: new MemoryJobStore() })

  const member = new Member({
    env,
    processEnv,
    table,
    inbox,
    grants,
    status: new OneShotStatus(),
    workspace,
    claudeCodeVersion: opts.claudeCodeVersion ?? (await readClaudeVersion(env.claudeBin, processEnv, env.workspace)),
    ...(opts.mcp ? { mcp: opts.mcp } : {}),
    ...(opts.onEvent ? { onEvent: (_jobId: string, line: string, event: ClaudeEvent | undefined) => opts.onEvent!(line, event) } : {}),
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    log,
    idlePollMs: 25,
  })

  const controller = new AbortController()
  const run = member.run(controller.signal)
  const outcome = await inbox.done
  controller.abort()
  await run
  return outcome
}

/** Seams of {@link runForkable}. */
export interface ForkableOptions extends OneShotOptions {
  /** Made at process start, before a fork can happen. */
  watcher: Watcher
  /** Called with the outcome of each run, before a park. */
  onOutcome?: (outcome: OneShotOutcome) => void
  /** Test seams. */
  run?: typeof runOneShot
  park?: typeof parkAfterResult
}

/**
 * Run the dispatch, and run the task of a fork when this run is forked (D74).
 * A fork source (`GIBSON_FORKABLE=1`) parks after a passing result. The
 * parent returns at the end of the park. A fork claims its own dispatch once
 * and runs that task, and the outcome of the fork is returned. A failed run
 * does not park.
 */
export async function runForkable(opts: ForkableOptions): Promise<OneShotOutcome> {
  const run = opts.run ?? runOneShot
  const parkFor = opts.park ?? parkAfterResult
  let env = opts.env
  for (;;) {
    const outcome = await run({ ...opts, env })
    opts.onOutcome?.(outcome)
    if (outcome.isError) return outcome
    const next = await parkFor(env, opts.watcher, { insecure: env[MEMBER_ENV.callbackInsecure] === "1" })
    if (!next) return outcome
    opts.log?.("this process is a fork: running the task of the fork")
    env = next
  }
}
