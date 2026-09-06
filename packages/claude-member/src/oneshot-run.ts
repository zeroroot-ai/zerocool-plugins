// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { readMemberEnv, type MemberEnv } from "./env.js"
import type { ClaudeEvent } from "./events.js"
import type { McpGateway } from "./inbox.js"
import { JobTable, MemoryJobStore } from "./job.js"
import { Member } from "./member.js"
import { dispatchGrants, jobSpecFromDispatch, OneShotInbox, OneShotStatus, oneShotMemberEnv, readDispatch, type OneShotOutcome } from "./oneshot.js"
import { readClaudeVersion } from "./version.js"
import { WorkspaceManager, type MergeRequestOpener } from "./workspace.js"

/**
 * Run one dispatched Task as a single auto-closed job (zerocool-plugins#111).
 *
 * The launch supplies the task, the per-dispatch grant and the callback
 * endpoint (gibson ADR-0016). That grant is both the member base grant and the
 * turn grant, because a one-shot run has exactly one dispatch. The turn runner,
 * the job table and the workspace manager are the member's, unchanged.
 */
export interface OneShotOptions {
  env: NodeJS.ProcessEnv
  /** Every stream-json line, for the live console. */
  onEvent?: (line: string, event: ClaudeEvent | undefined) => void
  log?: (line: string) => void
  /** `GetCredential` under the dispatch grant. Required when the task names a repository. */
  credential?: (name: string) => Promise<string>
  mergeRequests?: MergeRequestOpener
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

  if (spec.repositories.length > 0 && !opts.credential) {
    throw new Error(
      `the task names repository ${spec.repositories[0]!.cloneUrl} but no credential resolver was supplied. ` +
        "The connector token is resolved through GetCredential under the dispatch grant.",
    )
  }

  const workspace = new WorkspaceManager({
    root: env.workspace,
    stateDir: env.stateDir,
    capBytes: env.workspaceCapBytes,
    credential: opts.credential ?? (async (name: string) => Promise.reject(new Error(`no credential resolver for ${name}`))),
    ...(opts.mergeRequests ? { mergeRequests: opts.mergeRequests } : {}),
    log,
  })

  // A one-shot sandbox is torn down after the run and nothing resumes it, so
  // the table lives in memory. A member persists its table; this shape has
  // nothing to come back to.
  const table = new JobTable({ cap: 1, store: new MemoryJobStore() })

  const member = new Member({
    env,
    processEnv: opts.env,
    table,
    inbox,
    grants,
    status: new OneShotStatus(),
    workspace,
    claudeCodeVersion: opts.claudeCodeVersion ?? (await readClaudeVersion(env.claudeBin, opts.env, env.workspace)),
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
