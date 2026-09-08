// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { spawn } from "node:child_process"

import type { DevboxResult } from "./devbox.js"

/**
 * The same command, on this host.
 *
 * This runs only after the Devbox proved absent: a daemon built without the
 * setec integration, or one with no `sandbox.devbox.image` configured, answers
 * `Unavailable` (gibson `internal/engine/harness/callback_devbox_exec.go:60`).
 * Degrading here keeps a working coding agent, which is the same discipline
 * the main plugin keeps when it cannot reach the platform at all.
 *
 * It is deliberately the SAME shell form the Devbox path builds, so the two
 * backends disagree about where a command runs and about nothing else.
 */
export function runOnHost(
  argv: string[],
  opts: { cwd?: string; stdin?: Uint8Array; signal?: AbortSignal },
): Promise<DevboxResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      signal: opts.signal,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const decoder = new TextDecoder()
    let output = ""
    const collect = (chunk: Buffer): void => {
      output += decoder.decode(chunk, { stream: true })
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    child.stdin.end(opts.stdin ? Buffer.from(opts.stdin) : undefined)

    child.on("error", (e) => {
      resolve({ outcome: "error", exitCode: 0, output: output + decoder.decode(), message: e.message })
    })
    child.on("close", (code, signal) => {
      output += decoder.decode()
      if (code === null) {
        // Killed by a signal, so there is no exit code to report. The outcome
        // is unknown for the same reason a cut Devbox stream is.
        resolve({
          outcome: "unknown",
          exitCode: 0,
          output,
          message: `the command was terminated by ${signal ?? "a signal"}`,
        })
        return
      }
      resolve({ outcome: "exited", exitCode: code, output, message: "" })
    })
  })
}
