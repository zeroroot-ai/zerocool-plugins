// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { Code, ConnectError } from "@connectrpc/connect"

import type { DevboxExecMessage, DevboxResult } from "./devbox.js"
import type { HarnessClient } from "./harness.js"
import { execPlugin, SHELL_TOOL_ID, type ToolContext, type ToolDefinition } from "./plugin.js"
import { selectHarness } from "./harness.js"

/**
 * Which backend runs a command, and what the model is told about it.
 *
 * Two failures matter. Reporting a command as run when the stream never said
 * so puts a made-up build result in the transcript. And hanging, or refusing
 * every command, when the daemon has no Devbox turns a working coding agent
 * into a broken one — the failure the main plugin's fail-open discipline
 * exists to prevent.
 */

const fakeInput = {} as never
const silent = (): void => {}
const utf8 = new TextEncoder()

const context = (): ToolContext => ({
  sessionID: "ses_1",
  directory: "/home/dev/repo",
  abort: new AbortController().signal,
})

/** A harness client whose `devboxExec` replays messages, or throws. */
function fakeClient(
  messages: DevboxExecMessage[],
  seen: unknown[] = [],
  throws?: unknown,
): HarnessClient {
  return {
    devboxExec: (req: unknown) => {
      seen.push(req)
      if (throws) throw throws
      return (async function* () {
        for (const m of messages) yield m
      })()
    },
  } as unknown as HarnessClient
}

async function toolOf(
  client: HarnessClient,
  onHost?: (argv: string[], opts: { cwd?: string }) => Promise<DevboxResult>,
  log: (m: string) => void = silent,
): Promise<ToolDefinition> {
  const hooks = await execPlugin(fakeInput, {
    env: { GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: "t" },
    openHarness: () => ({ client, stop: silent }) as never,
    log,
    ...(onHost ? { onHost: onHost as never } : {}),
  })
  const tool = (hooks.tool as unknown as Record<string, ToolDefinition>)[SHELL_TOOL_ID]
  assert.ok(tool, "Platform mode must contribute the shell tool")
  return tool
}

test("standalone contributes no tool, so opencode runs the command on this host", async () => {
  const hooks = await execPlugin(fakeInput, { env: {}, log: silent })
  assert.deepEqual(Object.keys(hooks), [], "no platform means opencode, unchanged")
})

test("Platform mode takes over the built-in shell tool id", async () => {
  const hooks = await execPlugin(fakeInput, {
    env: { GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: "t" },
    openHarness: () => ({ client: fakeClient([]), stop: silent }) as never,
    log: silent,
  })
  assert.deepEqual(Object.keys(hooks.tool ?? {}), ["bash"], "the id opencode's own shell tool uses")
})

test("a command runs in the Devbox, keyed by opencode's session id", async () => {
  const seen: unknown[] = []
  const tool = await toolOf(
    fakeClient(
      [
        { payload: { case: "stdout", value: utf8.encode("ok\n") } },
        { payload: { case: "exit", value: { exitCode: 0 } } },
      ],
      seen,
    ),
  )
  const result = await tool.execute({ command: "make test" }, context())

  assert.equal(result.output, "ok\n")
  assert.equal(result.metadata.exit, 0)
  assert.equal(result.metadata.where, "the Gibson Devbox")
  assert.deepEqual(seen, [{ sessionId: "ses_1", argv: ["sh", "-lc", "make test"], stdin: new Uint8Array() }])
})

test("a stream with no exit event fails the tool call instead of reporting success", async () => {
  const tool = await toolOf(fakeClient([{ payload: { case: "stdout", value: utf8.encode("half") } }]))
  await assert.rejects(() => tool.execute({ command: "make test" }, context()), /no exit event/)
})

test("Unavailable degrades to this host, once, with one warning", async () => {
  const hostCalls: string[][] = []
  const warnings: string[] = []
  const onHost = async (argv: string[]): Promise<DevboxResult> => {
    hostCalls.push(argv)
    return { outcome: "exited", exitCode: 0, output: "on host", message: "" }
  }
  const seen: unknown[] = []
  const client = fakeClient([], seen, new ConnectError("no devbox image configured", Code.Unavailable))
  const tool = await toolOf(client, onHost, (m) => warnings.push(m))

  const first = await tool.execute({ command: "make test" }, context())
  assert.equal(first.output, "on host")
  assert.equal(first.metadata.where, "this host")
  assert.equal(warnings.filter((w) => w.includes("not available")).length, 1)

  const second = await tool.execute({ command: "make build" }, context())
  assert.equal(second.output, "on host")
  assert.equal(hostCalls.length, 2)
  assert.equal(seen.length, 1, "a daemon with no Devbox is not retried on every command")
  assert.equal(warnings.filter((w) => w.includes("not available")).length, 1, "one warning, not one per command")
})

test("the host fallback runs the same shell form, in the session directory", async () => {
  const calls: { argv: string[]; cwd?: string }[] = []
  const onHost = async (argv: string[], opts: { cwd?: string }): Promise<DevboxResult> => {
    calls.push({ argv, cwd: opts.cwd })
    return { outcome: "exited", exitCode: 0, output: "", message: "" }
  }
  const tool = await toolOf(
    fakeClient([], [], new ConnectError("not wired", Code.Unimplemented)),
    onHost,
  )
  await tool.execute({ command: "ls" }, context())
  assert.deepEqual(calls, [{ argv: ["sh", "-lc", "ls"], cwd: "/home/dev/repo" }])
})

test("a failure that is not Unavailable is raised, not swallowed onto the host", async () => {
  const onHost = async (): Promise<DevboxResult> => {
    throw new Error("the host backend must not run for a denied command")
  }
  const tool = await toolOf(
    fakeClient([], [], new ConnectError("no tenant in caller identity", Code.PermissionDenied)),
    onHost,
  )
  await assert.rejects(() => tool.execute({ command: "ls" }, context()), /no tenant in caller identity/)
})

test("an empty command is refused before it reaches either backend", async () => {
  const tool = await toolOf(fakeClient([]))
  await assert.rejects(() => tool.execute({ command: "   " }, context()), /command is required/)
})

test("the dispatched grant wins when a host key is also present", async () => {
  const selected = await selectHarness({
    env: {
      GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
      GIBSON_CALLBACK_TOKEN: "t",
      GIBSON_PLATFORM_URL: "https://api.example:30443",
    },
    hostKeyExists: () => true,
    openHarness: () => ({ client: fakeClient([]), stop: silent }) as never,
    openComponent: async () => {
      throw new Error("the component grant must not be opened when a dispatch grant is present")
    },
  })
  assert.equal(selected.mode, "task")
})

test("an endpoint with no token stays on this host rather than widening authority", async () => {
  const selected = await selectHarness({
    env: { GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_PLATFORM_URL: "https://api.example" },
    hostKeyExists: () => true,
  })
  assert.equal(selected.mode, "standalone")
  assert.match(selected.reason, /widen this run's authority/)
})

test("a platform URL with no host key stays on this host rather than spending a bootstrap token", async () => {
  const selected = await selectHarness({
    env: { GIBSON_PLATFORM_URL: "https://api.example:30443", GIBSON_HOST_KEY_PATH: "/nope/host.key" },
    hostKeyExists: () => false,
  })
  assert.equal(selected.mode, "standalone")
  assert.match(selected.reason, /has not checked in/)
})

test("an interactive run runs in the Devbox on the component grant", async () => {
  const selected = await selectHarness({
    env: { GIBSON_PLATFORM_URL: "https://api.example:30443", GIBSON_HOST_KEY_PATH: "/keys/host.key" },
    hostKeyExists: (p) => p === "/keys/host.key",
    openComponent: async (opts) => {
      assert.equal(opts.hostKeyPath, "/keys/host.key")
      assert.equal(opts.agentName, "zerocool")
      return fakeClient([])
    },
  })
  assert.equal(selected.mode, "component")
})
