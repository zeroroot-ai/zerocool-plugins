// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { Code, ConnectError } from "@connectrpc/connect"

/**
 * One command in the session Devbox, over `DevboxExec`.
 *
 * `DevboxExec(session_id, argv, stdin) -> stream(stdout | stderr | exit |
 * error)` is a server stream on `HarnessCallbackService`. The daemon resolves
 * a session-lifetime sandbox by (tenant, session_id), launches it lazily on
 * the first command, and REUSES it after that, so `git clone` and then `go
 * build` see one `/workspace` (gibson
 * `internal/engine/harness/sandboxed/session.go`). The tenant comes from the
 * caller's identity, so no request names one.
 *
 * THE STREAM CONTRACT IS THE POINT. Exactly one terminal message ends a
 * healthy stream: an exit, or an error. A stream that ends without one was cut
 * by transport or server failure, and "the command succeeded" and "the
 * connection dropped" must never look alike. So a missing terminal event is
 * reported as an UNKNOWN outcome, never as success and never as a zero exit
 * code.
 */

/** How a command ended. */
export type DevboxOutcome = "exited" | "error" | "unknown"

export interface DevboxResult {
  outcome: DevboxOutcome
  /** The exit code. Meaningful only when `outcome` is `exited`. */
  exitCode: number
  /** stdout and stderr, interleaved in arrival order, as the stream sent them. */
  output: string
  /** Why the command did not run, when `outcome` is `error` or `unknown`. */
  message: string
}

/** The three fields a `DevboxExec` call carries, plus the abort seam. */
export interface DevboxCommand {
  sessionId: string
  argv: string[]
  stdin?: Uint8Array
  signal?: AbortSignal
}

/**
 * The `DevboxExec` response, as the generated bindings shape it. Declared
 * structurally so a test can drive `run` with a plain async generator.
 */
export interface DevboxExecMessage {
  payload:
    | { case: "stdout"; value: Uint8Array }
    | { case: "stderr"; value: Uint8Array }
    | { case: "exit"; value: { exitCode: number } }
    | { case: "error"; value: { message?: string } }
    | { case: undefined; value?: undefined }
}

/** The one method of the harness client this module calls. */
export type DevboxExecCall = (
  req: { sessionId: string; argv: string[]; stdin: Uint8Array },
  opts?: { signal?: AbortSignal },
) => AsyncIterable<DevboxExecMessage>

/** The Devbox is not there. See {@link isDevboxAbsent}. */
export function isDevboxAbsent(e: unknown): boolean {
  const code = ConnectError.from(e).code
  return code === Code.Unavailable || code === Code.Unimplemented
}

/** Run one command and drain its stream. Never throws for a command failure. */
export async function runInDevbox(exec: DevboxExecCall, cmd: DevboxCommand): Promise<DevboxResult> {
  const decoder = new TextDecoder()
  let output = ""
  let terminal: DevboxResult | undefined

  const stream = exec(
    { sessionId: cmd.sessionId, argv: cmd.argv, stdin: cmd.stdin ?? new Uint8Array() },
    cmd.signal ? { signal: cmd.signal } : undefined,
  )
  for await (const message of stream) {
    const payload = message.payload
    switch (payload.case) {
      case "stdout":
      case "stderr":
        // Chunk boundaries are transport artifacts, not line boundaries, so
        // the two streams are concatenated in arrival order and never sorted.
        output += decoder.decode(payload.value, { stream: true })
        break
      case "exit":
        terminal = { outcome: "exited", exitCode: payload.value.exitCode, output: "", message: "" }
        break
      case "error":
        terminal = { outcome: "error", exitCode: 0, output: "", message: payload.value.message ?? "the Devbox reported an error" }
        break
      default:
        break
    }
    // The terminal event is last. Reading past it would block on a stream the
    // server has already finished with.
    if (terminal) break
  }
  output += decoder.decode()

  if (!terminal) {
    return {
      outcome: "unknown",
      exitCode: 0,
      output,
      message:
        "the Devbox stream ended with no exit event; the command may or may not have run, " +
        "so its outcome is unknown",
    }
  }
  return { ...terminal, output }
}
