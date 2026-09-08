// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { selectHarness, type HarnessClient, type HarnessSelectionDeps } from "./harness.js"

import { toDevboxArgv } from "./command.js"
import { isDevboxAbsent, runInDevbox, type DevboxExecCall, type DevboxResult } from "./devbox.js"
import { runOnHost } from "./host.js"

/**
 * `@zeroroot-ai/zerocool-exec` — the executor seam (zerocool-plugins#12).
 *
 * WHAT IT DOES. In Platform mode the agent's shell commands run in the session
 * Devbox instead of on the host, so untrusted repository bytes build and test
 * inside a microVM. The channel is `DevboxExec`: one server stream per
 * command, keyed by opencode's own session id, into a session-lifetime setec
 * sandbox that the daemon launches lazily on the first command and reuses
 * after that. Successive commands therefore share one `/workspace`, which is
 * the whole point of a Devbox over the per-call sandboxed tool path.
 *
 * HOW A PLUGIN ROUTES EXECUTION. opencode's `experimental_workspace.register`
 * exists in the pinned plugin API, but its adapter cannot carry a command:
 * `target()` returns either a LOCAL directory or a REMOTE opencode server URL
 * (`WorkspaceTarget` in `@opencode-ai/plugin` 1.18.27), and a Devbox is
 * neither. The remote form is the framing this issue struck, because it needs
 * an opencode server inside every microVM plus a public per-session ingress.
 *
 * What a plugin CAN do is contribute a tool. opencode's tool registry is
 * `[...builtin, ...custom]` collapsed into one map keyed by tool id, so a
 * plugin tool named `bash` — the id of the built-in shell tool — takes its
 * place. That is the hook this plugin uses, and it is the only one that routes
 * a command rather than observing it: `tool.execute.before` can rewrite the
 * arguments of the built-in tool but never where it runs, and `shell.env` sets
 * only the environment.
 *
 * ONE BACKEND, CHOSEN BY MODE. Standalone registers no tool at all, so
 * opencode's own shell tool runs the command on the host, exactly as it does
 * with no platform. Platform mode registers the tool and every command goes to
 * the Devbox. A daemon that answers `Unavailable` — built without the setec
 * integration, or with no devbox image configured — is not a transient
 * failure, so the plugin warns once, latches to the host, and stays there. It
 * never hangs and it never silently reports a command it did not run.
 */

/** Seams, so a test drives the plugin with no daemon and no child process. */
export interface ExecPluginDeps extends HarnessSelectionDeps {
  /** Where every line this plugin writes goes. Defaults to stderr. */
  log?: (message: string) => void
  /** Defaults to `node:child_process.spawn` through `runOnHost`. */
  onHost?: typeof runOnHost
}

/** opencode's tool-execute context, as this plugin reads it. */
interface ToolContext {
  sessionID: string
  directory: string
  abort: AbortSignal
}

/** The tool this plugin contributes, in the shape opencode's registry reads. */
interface ToolDefinition {
  description: string
  args: Record<string, unknown>
  execute(args: Record<string, unknown>, context: ToolContext): Promise<{ title: string; output: string; metadata: Record<string, unknown> }>
}

/** The id of opencode's built-in shell tool, which this plugin takes over. */
export const SHELL_TOOL_ID = "bash"

const DESCRIPTION =
  "Run a shell command in this session's Gibson Devbox, an isolated microVM with a workspace " +
  "that persists across commands in the session. Use it for terminal work: git, builds, tests, " +
  "package managers. It is not for reading, writing or searching files — use the file tools. " +
  "Each call runs `sh -lc <command>` from the Devbox working directory, so use `cd` inside the " +
  "command when you need another directory."

/**
 * opencode validates a plugin tool's arguments only when they are Zod schemas,
 * and it marks every argument of a plain JSON-Schema declaration as required
 * (opencode 1.18.27, the `ToolRegistry.state` schema builder). Zod would have
 * to be imported at run time from a peer this package does not install, so the
 * arguments are plain JSON Schema and this plugin validates them itself.
 */
const ARGS = {
  command: { type: "string", description: "The shell command to run in the Devbox." },
} as const

export async function execPlugin(input: PluginInput, deps: ExecPluginDeps = {}): Promise<Hooks> {
  const log = deps.log ?? ((m: string) => console.error(m))
  const onHost = deps.onHost ?? runOnHost

  const selected = await selectHarness(deps)
  if (!selected.client) {
    // One mode, chosen here: standalone contributes no tool, so opencode's own
    // shell tool runs on the host. That is opencode, unchanged.
    log(`[zerocool-exec] execution stays on this host, ${selected.reason}`)
    return {}
  }

  const exec = (selected.client as unknown as { devboxExec: DevboxExecCall }).devboxExec.bind(selected.client)
  let devboxGone = false
  log(`[zerocool-exec] shell commands run in the Gibson Devbox on the ${selected.mode} grant`)

  const run = async (command: string, context: ToolContext): Promise<DevboxResult> => {
    const argv = toDevboxArgv(command)
    if (devboxGone) return onHost(argv, { cwd: context.directory, signal: context.abort })
    try {
      return await runInDevbox(exec, { sessionId: context.sessionID, argv, signal: context.abort })
    } catch (e) {
      if (!isDevboxAbsent(e)) throw e
      devboxGone = true
      log(
        `[zerocool-exec] the Gibson Devbox is not available (${(e as Error).message}); ` +
          "commands run on this host for the rest of the session",
      )
      return onHost(argv, { cwd: context.directory, signal: context.abort })
    }
  }

  const shellTool: ToolDefinition = {
    description: DESCRIPTION,
    args: ARGS,
    async execute(args, context) {
      const command = typeof args.command === "string" ? args.command.trim() : ""
      if (!command) throw new Error("bash: command is required")

      const result = await run(command, context)
      const where = devboxGone ? "this host" : "the Gibson Devbox"
      if (result.outcome === "unknown" || result.outcome === "error") {
        // Never report an outcome the stream did not carry. "the command
        // succeeded" and "the connection dropped" must not look alike.
        throw new Error(`bash: ${result.message}\n${result.output}`)
      }
      return {
        title: command,
        output: result.output,
        metadata: { exit: result.exitCode, where, sessionID: context.sessionID },
      }
    },
  }

  return {
    tool: { [SHELL_TOOL_ID]: shellTool } as unknown as Hooks["tool"],
    dispose: async () => selected.stop(),
  } satisfies Hooks
}

/** Exported for the tests: the tool a Platform-mode plugin contributes. */
export type { ToolContext, ToolDefinition }
export type { HarnessClient }
