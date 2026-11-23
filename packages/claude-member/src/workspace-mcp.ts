// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * The member tool of Claude: `fetch_file(path)`.
 *
 * The workspace is sparse. A turn holds only the files the job names, and
 * Claude asks for any other file with this tool. The tool calls `read_file`
 * under the grant of the turn, so the daemon checks and records the call and
 * binds it to the job. The driver holds the grant. Claude never sees it.
 *
 * The server is a small MCP endpoint (streamable HTTP, JSON replies) on
 * loopback. Each turn registers its own handler and gets its own random path,
 * so one job cannot call the handler of another job. The handler is dropped
 * when the turn ends.
 */
export const FETCH_FILE_TOOL = "fetch_file"
export const WORKSPACE_SERVER_NAME = "workspace"

/** The result of one `fetch_file` call. */
export interface FetchResult {
  ok: boolean
  text: string
}

export type FetchHandler = (repository: string | undefined, path: string) => Promise<FetchResult>

export interface WorkspaceMcp {
  /** Make the endpoint of one turn. `dispose` ends it. */
  register(handler: FetchHandler): { url: string; dispose(): void }
  stop(): Promise<void>
}

const TOOL = {
  name: FETCH_FILE_TOOL,
  description:
    "Read one file of the repository into the worktree, so you can edit it. The workspace holds only the files the job names. " +
    "Call this before you change any other file that exists in the repository. A file that is not text or is too large is refused. " +
    "Create a new file by writing it, with no call.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The path of the file from the root of the repository." },
      repository: { type: "string", description: "The repository name. Needed only when the job has more than one." },
    },
    required: ["path"],
  },
} as const

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function reply(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text)
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new Error("body too large")
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function answer(rpc: RpcRequest, handler: FetchHandler): Promise<unknown | undefined> {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: rpc.id ?? null, result })
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } })
  if (rpc.id === undefined) return undefined // a notification has no reply
  switch (rpc.method) {
    case "initialize":
      return ok({
        protocolVersion: typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "zerocool-workspace", version: "1" },
      })
    case "ping":
      return ok({})
    case "tools/list":
      return ok({ tools: [TOOL] })
    case "tools/call": {
      if (rpc.params?.name !== FETCH_FILE_TOOL) return fail(-32602, `unknown tool ${String(rpc.params?.name)}`)
      const args = (rpc.params.arguments ?? {}) as { path?: unknown; repository?: unknown }
      if (typeof args.path !== "string" || args.path === "") return ok({ isError: true, content: [{ type: "text", text: "path is required." }] })
      try {
        const r = await handler(typeof args.repository === "string" && args.repository ? args.repository : undefined, args.path)
        return ok({ isError: !r.ok, content: [{ type: "text", text: r.text }] })
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: `fetch_file failed: ${(e as Error).message}` }] })
      }
    }
    default:
      return fail(-32601, `method ${String(rpc.method)} is not supported`)
  }
}

/** Start the endpoint on a loopback port the kernel picks. */
export async function startWorkspaceMcp(host = "127.0.0.1"): Promise<WorkspaceMcp> {
  const handlers = new Map<string, FetchHandler>()
  const server: Server = createServer((req, res) => {
    void (async () => {
      const m = /^\/t\/([A-Za-z0-9_-]{20,})\/mcp$/.exec(req.url ?? "")
      const handler = m ? handlers.get(m[1]!) : undefined
      if (!handler) return reply(res, 404)
      if (req.method !== "POST") return reply(res, 405)
      let rpc: RpcRequest
      try {
        rpc = JSON.parse(await readBody(req)) as RpcRequest
      } catch {
        return reply(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
      }
      const body = await answer(rpc, handler)
      if (body === undefined) return reply(res, 202)
      reply(res, 200, body)
    })().catch(() => reply(res, 500))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, host, resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    register(handler) {
      const token = randomBytes(24).toString("base64url")
      handlers.set(token, handler)
      return { url: `http://${host}:${port}/t/${token}/mcp`, dispose: () => void handlers.delete(token) }
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // A client that keeps its connection alive must not hold the stop.
        server.closeAllConnections()
      }),
  }
}
