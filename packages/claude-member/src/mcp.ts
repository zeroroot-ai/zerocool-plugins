// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { resolveBin } from "./claude-run.js"
import type { McpGateway } from "./inbox.js"
import { trimTrailingSlashes } from "./text.js"

/**
 * The Gibson MCP server inside the member sandbox (zerocool-plugins#108,
 * epic decisions 14 and 16).
 *
 * The server is `@zeroroot-ai/gibson-mcp`, run as its own process on a
 * loopback port. Claude Code attaches to it over streamable HTTP with
 * `--mcp-config` and `--strict-mcp-config`, and asks it for permission
 * through `--permission-prompt-tool mcp__gibson__ask`.
 *
 * PER-TURN GRANT. One sandbox serves many dispatches over its life, so every
 * input carries the task grant of its own dispatch and every tool call in
 * that turn must use it. Before a turn starts the driver puts the grant in
 * force with `POST /turn {job_id, grant, callback_endpoint, insecure}`, and
 * ends it with `DELETE /turn` when the turn is over. Between turns the
 * server falls back to its base grant. A stdio server that Claude Code
 * spawns per session cannot do this, which is why the transport is HTTP.
 *
 * A CHILD PROCESS, NOT A LIBRARY IMPORT. The slice was written as a library
 * import. `@zeroroot-ai/gibson-mcp` cannot be a build-time dependency yet:
 * it is not on npm, and its git tag declares `@zeroroot-ai/sdk` as
 * `workspace:^`, which no install outside the `sdk-ts` workspace can
 * resolve. The image installs the server and the driver spawns its bin, so
 * the two lifetimes are separate and a crash in one does not take the other.
 * The wire contract is the same either way.
 */
export const MCP_PATH = "/mcp"
export const DEFAULT_MCP_HOST = "127.0.0.1"

export class McpError extends Error {}

/** Ask the kernel for a free loopback port. */
export async function freePort(host = DEFAULT_MCP_HOST): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new McpError("the kernel gave no port for the MCP server"))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

/** The body the server reads on `POST /turn`. Snake case: it is the wire. */
export interface TurnBody {
  job_id: string
  grant: string
  callback_endpoint?: string
  insecure?: boolean
}

export interface McpServerOptions {
  /** The server bin. A `.js` path runs under node. */
  bin: string
  /** The harness endpoint the server reports through, on the turn's grant. */
  callbackEndpoint: string
  insecure: boolean
  /** The server's own environment: the base grant and the endpoint. */
  env: NodeJS.ProcessEnv
  cwd: string
  host?: string
  /** `0` asks the kernel for a free one. */
  port?: number
  /** How long to wait for `/healthz`. Default 30s, the MCP startup timeout. */
  readyTimeoutMs?: number
  log?: (line: string) => void
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
}

export interface McpServer extends McpGateway {
  /** The base url, e.g. `http://127.0.0.1:7788`. */
  base: string
  pid: number | undefined
  stop(): Promise<void>
}

/** The gateway over an already-running server. */
export function mcpGateway(base: string, opts: { callbackEndpoint?: string; insecure?: boolean; fetch?: typeof globalThis.fetch; log?: (line: string) => void }): McpGateway {
  const doFetch = opts.fetch ?? globalThis.fetch
  const log = opts.log ?? (() => {})
  const root = trimTrailingSlashes(base)
  const url = `${root}/turn`
  return {
    url: `${root}${MCP_PATH}`,
    async useGrant(jobId: string, grant: string): Promise<void> {
      const body: TurnBody = {
        job_id: jobId,
        grant,
        ...(opts.callbackEndpoint ? { callback_endpoint: opts.callbackEndpoint } : {}),
        ...(opts.insecure ? { insecure: true } : {}),
      }
      const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      if (!res.ok) {
        // The grant is never in the message: this text reaches the console.
        throw new McpError(`POST /turn for job ${jobId} answered ${res.status}`)
      }
    },
    async release(jobId: string): Promise<void> {
      const res = await doFetch(url, { method: "DELETE" })
      if (!res.ok) log(`mcp: DELETE /turn after job ${jobId} answered ${res.status}`)
    },
  }
}

/**
 * Start the server and wait until it answers `/healthz`.
 *
 * The server holds the member base grant, so it is started with the member's
 * own environment. It is never given a job's grant at start: a turn puts one
 * in force and takes it away again.
 */
export async function startMcpServer(opts: McpServerOptions): Promise<McpServer> {
  const host = opts.host ?? DEFAULT_MCP_HOST
  const port = opts.port && opts.port > 0 ? opts.port : await freePort(host)
  const log = opts.log ?? (() => {})
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const doFetch = opts.fetch ?? globalThis.fetch
  const base = `http://${host}:${port}`

  const { command, prefix } = resolveBin(opts.bin)
  const child: ChildProcess = spawn(command, [...prefix, "--transport", "http", "--listen", `${host}:${port}`], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stderr: string[] = []
  child.stdout?.on("data", (d: Buffer) => log(`mcp: ${d.toString().trimEnd()}`))
  child.stderr?.on("data", (d: Buffer) => {
    const line = d.toString()
    stderr.push(line)
    if (stderr.length > 50) stderr.shift()
    log(`mcp: ${line.trimEnd()}`)
  })
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
  child.on("exit", (code, signal) => (exited = { code, signal }))

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 30_000)
  let ready = false
  while (Date.now() < deadline && !ready) {
    if (exited) {
      throw new McpError(`the MCP server exited ${exited.code ?? exited.signal} before it was ready: ${stderr.join("").trim().slice(0, 500)}`)
    }
    try {
      const res = await doFetch(`${base}/healthz`)
      ready = res.ok
    } catch {
      ready = false
    }
    if (!ready) await sleep(100)
  }
  if (!ready) {
    child.kill("SIGTERM")
    throw new McpError(`the MCP server did not answer ${base}/healthz within ${opts.readyTimeoutMs ?? 30_000}ms: ${stderr.join("").trim().slice(0, 500)}`)
  }
  log(`mcp: serving ${base}${MCP_PATH}`)

  const gateway = mcpGateway(base, {
    callbackEndpoint: opts.callbackEndpoint,
    insecure: opts.insecure,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    log,
  })
  return {
    ...gateway,
    base,
    pid: child.pid,
    async stop(): Promise<void> {
      if (exited) return
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        if (exited) {
          resolve()
          return
        }
        child.once("exit", () => resolve())
        setTimeout(() => resolve(), 5000).unref?.()
      })
    },
  }
}
