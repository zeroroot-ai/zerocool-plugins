// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { TaskHarness } from "@zeroroot-ai/sdk"

/**
 * The driver calls a connector tool through the governed path.
 *
 * The path is the `invoke_tool` meta-tool of `HarnessCallbackService.CallToolProto`.
 * The daemon checks the grant of the call, checks `can_execute` on the
 * connector, runs the tool and records the call. The sandbox holds no forge
 * credential and runs no git transport. A tool call is the only way the
 * workspace reads a repository or delivers a change.
 */

/** Calls one connector tool under `grant`. Returns the tool result, or throws {@link ToolCallError}. */
export type ToolCaller = (grant: string, connectorRef: string, tool: string, args: Record<string, unknown>) => Promise<unknown>

/** The daemon or the tool refused the call. The message is the daemon's own text. */
export class ToolCallError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    /** True when a later try can succeed: a network failure, UNAVAILABLE, or "call the tool again". */
    readonly transient = false,
  ) {
    super(`${tool}: ${message}`)
    this.name = "ToolCallError"
  }
}

/**
 * The canonical tool id of a connector tool: `mcp:<connector>:<tool>`. The
 * connector reference of a job has the form `connector/<name>`, and the id
 * carries the name.
 */
export function connectorToolId(connectorRef: string, tool: string): string {
  const name = connectorRef.split("/").pop() ?? connectorRef
  if (!name || name.includes(":")) throw new Error(`connector reference ${JSON.stringify(connectorRef)} names no connector`)
  return `mcp:${name}:${tool}`
}

/** The part of a task harness that a tool call needs. A test supplies a fake. */
export interface ToolHarness {
  context: TaskHarness["context"]
  client: Pick<TaskHarness["client"], "callToolProto">
  /** The grant in use now. The harness renews its grant, so this changes. */
  token(): string
  stop(): void
}

/**
 * The codes of `HarnessError` that mean the call did not run to an answer and a
 * later try can succeed: TIMEOUT (the deadline), UNAVAILABLE, RESOURCE_EXHAUSTED.
 */
const TRANSIENT_HARNESS_CODES = new Set([4, 5, 8])

/** The gRPC codes of a transport failure that a later try can mend: deadline exceeded, resource exhausted, unavailable. */
const TRANSIENT_GRPC_CODES = new Set([4, 8, 14])

/** A {@link ToolCaller} that also says which grant is in force. */
export type GrantedToolCaller = ToolCaller & {
  /** Stop the harness of `grant` and its renewal timer. Called when the job that held the grant ends. */
  release(grant: string): void
  /**
   * The grant in use now for `grant`. The harness of a grant renews it before it
   * expires, so a turn that holds the harness keeps a live grant. The first call
   * opens the harness and starts the renewal.
   */
  current(grant: string): string
}

/**
 * A {@link ToolCaller} over `CallToolProto`. `open` makes a harness that sends
 * `grant` on every call and renews it while it is live (`RenewCapabilityGrant`).
 * The caller keeps one harness for each recent grant, so a run of calls under
 * one grant uses one connection and one renewal, and it stops the oldest.
 */
export function harnessToolCaller(open: (grant: string) => ToolHarness, keep = 16): GrantedToolCaller {
  const held = new Map<string, ToolHarness>()
  const harnessFor = (grant: string): ToolHarness => {
    const have = held.get(grant)
    if (have) return have
    if (held.size >= keep) {
      const oldest = held.keys().next().value as string
      held.get(oldest)?.stop()
      held.delete(oldest)
    }
    const harness = open(grant)
    held.set(grant, harness)
    return harness
  }
  const call: ToolCaller = async (grant, connectorRef, tool, args) => {
    const harness = harnessFor(grant)
    let res
    try {
      res = await harness.client.callToolProto({
        context: harness.context,
        name: "invoke_tool",
        inputJson: new TextEncoder().encode(JSON.stringify({ id: connectorToolId(connectorRef, tool), args })),
      })
    } catch (e) {
      const code = (e as { code?: unknown }).code
      throw new ToolCallError(tool, (e as Error).message, typeof code === "number" && TRANSIENT_GRPC_CODES.has(code))
    }
    if (res.error) {
      const message = res.error.message || "the call was refused"
      // The code is the only classification. A failure with no retryable code is permanent, and the job fails
      // with the reason in view. The text is never read.
      throw new ToolCallError(tool, message, TRANSIENT_HARNESS_CODES.has(Number(res.error.code ?? 0)))
    }
    if (res.outputJson.length === 0) return undefined
    const body = JSON.parse(new TextDecoder().decode(res.outputJson)) as { result?: unknown }
    return body.result
  }
  return Object.assign(call, {
    current: (grant: string) => harnessFor(grant).token(),
    release: (grant: string) => {
      held.get(grant)?.stop()
      held.delete(grant)
    },
  })
}
