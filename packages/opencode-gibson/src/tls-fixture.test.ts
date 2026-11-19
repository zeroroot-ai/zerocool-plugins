// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI
// The helpers of the gateway tests. The file name keeps it out of the build.

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingHttpHeaders } from "node:http"
import { createServer as createTlsServer } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A private CA, and a way to sign a localhost server certificate with it. Test helper. */
export interface Ca {
  pem: string
  sign: () => { key: string; cert: string }
}

/** What a fake gateway saw. */
export interface Seen {
  method?: string
  url?: string
  headers: IncomingHttpHeaders
  body: string
}

/** Make a private CA with openssl. The temporary files go when the process exits. */
export function makeCa(name: string): Ca {
  const dir = mkdtempSync(join(tmpdir(), "zerocool-ca-"))
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }))
  const run = (...args: string[]): void => void execFileSync("openssl", args, { cwd: dir, stdio: "ignore" })
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", `/CN=${name}`)
  return {
    pem: readFileSync(join(dir, "ca.pem"), "utf8"),
    sign: () => {
      writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n")
      run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost")
      run("x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "2", "-extfile", "ext.cnf")
      return { key: readFileSync(join(dir, "srv.key"), "utf8"), cert: readFileSync(join(dir, "srv.pem"), "utf8") }
    },
  }
}

const responseBody = JSON.stringify({ id: "resp_1", status: "completed", output: [] })

function record(seen: Seen[]) {
  return (
    req: { method?: string; url?: string; headers: IncomingHttpHeaders; on: (e: string, f: (d?: Buffer) => void) => void },
    res: { writeHead: (s: number, h: Record<string, string>) => { end: (b: string) => void } },
  ): void => {
    let body = ""
    req.on("data", (d?: Buffer) => (body += d?.toString() ?? ""))
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(200, { "content-type": "application/json" }).end(responseBody)
    })
  }
}

/** A fake TLS gateway, with a certificate that `ca` signed. The URL names `localhost`. */
export async function withTlsGateway(ca: Ca, fn: (url: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = []
  const server = createTlsServer(ca.sign(), record(seen) as never)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  try {
    await fn(`https://localhost:${(server.address() as AddressInfo).port}`, seen)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

/** A fake plain http server. A gateway URL that names it must be refused. */
export async function withHttpServer(fn: (url: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = []
  const server = createServer(record(seen) as never)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen)
  } finally {
    await new Promise((r) => server.close(r))
  }
}
