// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * From opencode's shell tool arguments to a `DevboxExec` argv.
 *
 * opencode's built-in shell tool takes `command`, an optional `workdir` and an
 * optional `timeout` (opencode 1.18.27, `ShellTool`). `DevboxExec` takes an
 * exec-style argv and NOTHING else: there is no working-directory field on
 * `DevboxExecRequest`, and the server does not shell-interpret argv.
 *
 * So a command becomes `sh -lc <script>`, which is the shell the model already
 * writes for, and a `workdir` becomes a `cd` in front of it. The path is
 * single-quoted, and a single quote inside it is closed, escaped and reopened,
 * so a directory name cannot end the quoting and run something else.
 */

/** Quote one argument for `sh`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** The argv for one shell command in the Devbox. */
export function toDevboxArgv(command: string, workdir?: string): string[] {
  const script = workdir ? `cd -- ${shellQuote(workdir)} && ${command}` : command
  return ["sh", "-lc", script]
}
