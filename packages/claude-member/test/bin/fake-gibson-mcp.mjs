#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// A stand-in for the `gibson-mcp` bin: the three routes the driver uses,
// /healthz, POST/GET/DELETE /turn, and nothing else. Knobs:
//
//   FAKE_MCP_READY_AFTER_MS   answer /healthz only after this long (default 0)
//   FAKE_MCP_EXIT             exit with this code instead of serving
import { createServer } from "node:http"

if (process.env.FAKE_MCP_EXIT) {
  process.stderr.write("no grant: GIBSON_CG_JWT is not set\n")
  process.exit(Number(process.env.FAKE_MCP_EXIT))
}

const args = process.argv.slice(2)
const listen = args[args.indexOf("--listen") + 1] ?? "127.0.0.1:0"
const [host, port] = listen.split(":")
const readyAfter = Number(process.env.FAKE_MCP_READY_AFTER_MS ?? 0)
const started = Date.now()
let turn = null

createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const json = (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
      res.end(text)
    }
    if (req.url === "/healthz") {
      if (Date.now() - started < readyAfter) return json(503, { ok: false })
      return json(200, { ok: true, sessions: 0 })
    }
    if (req.url === "/turn") {
      if (req.method === "DELETE") {
        turn = null
        return json(200, { job_id: null })
      }
      if (req.method === "GET") return json(200, turn ? { job_id: turn.job_id, endpoint: "gibson:50001" } : { job_id: null })
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
      if (!body.job_id || !body.grant) return json(400, { error: "job_id and grant are both required" })
      turn = body
      return json(200, { job_id: body.job_id, endpoint: body.callback_endpoint ?? "" })
    }
    json(404, { error: `no route ${req.method} ${req.url}` })
  })
}).listen(Number(port), host)
