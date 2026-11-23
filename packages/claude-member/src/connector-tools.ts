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
  stop(): void
}

/**
 * A {@link ToolCaller} over `CallToolProto`. `open` makes a harness that sends
 * `grant` on every call. The caller keeps the harness of the latest grant and
 * stops the one that it replaces, so a run of many calls under one grant uses
 * one connection.
 */
export function harnessToolCaller(open: (grant: string) => ToolHarness): ToolCaller {
  let current: { grant: string; harness: ToolHarness } | undefined
  const harnessFor = (grant: string): ToolHarness => {
    if (current?.grant === grant) return current.harness
    current?.harness.stop()
    current = { grant, harness: open(grant) }
    return current.harness
  }
  return async (grant, connectorRef, tool, args) => {
    const harness = harnessFor(grant)
    const res = await harness.client.callToolProto({
      context: harness.context,
      name: "invoke_tool",
      inputJson: new TextEncoder().encode(JSON.stringify({ id: connectorToolId(connectorRef, tool), args })),
    })
    if (res.error) throw new ToolCallError(tool, res.error.message || "the call was refused")
    if (res.outputJson.length === 0) return undefined
    const body = JSON.parse(new TextDecoder().decode(res.outputJson)) as { result?: unknown }
    return body.result
  }
}
