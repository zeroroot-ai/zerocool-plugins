// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { createSecureServer, type Http2SecureServer } from "node:http2"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { ComponentService, HarnessCallbackService } from "@zeroroot-ai/sdk"
import { claudeChildEnv } from "./env.js"
import { HarnessInbox } from "./harness-inbox.js"
import { ComponentHeartbeat, openComponentClient } from "./heartbeat.js"
import type { JobInput, MemberStatus } from "./inbox.js"
import { openHarness, specOptionsFor } from "./member-main.js"
import { certificateBlocks, childEnv, EXTRA_CA_CERTS_ENV, PLATFORM_CA_ENV, PLATFORM_CA_FILE, platformTrust, writePlatformCa } from "./platform-ca.js"

/**
 * The platform CA end to end (zerocool-plugins#73): a self-signed test CA, a
 * local TLS server presenting a leaf it signed, and the driver's own clients
 * on it. With `GIBSON_PLATFORM_CA_PEM` the heartbeat and the inbox
 * subscription succeed. Without it they fail the way the kind run did.
 */
interface TestPki {
  caPem: string
  leafKey: string
  leafPem: string
}

/** A CA and a leaf for 127.0.0.1, minted by openssl into `dir`. */
function mintPki(dir: string): TestPki {
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"]
  const ssl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] })
  ssl(["req", "-x509", "-new", ...ec, "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=zerocool test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"])
  ssl(["req", "-new", ...ec, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"])
  ssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-copy_extensions", "copy"])
  const read = (name: string) => execFileSync("cat", [join(dir, name)]).toString("utf8")
  return { caPem: read("ca.pem"), leafKey: read("leaf.key"), leafPem: read("leaf.pem") }
}

/** A grant with the claims the harness derives its context from. Never verified here. */
function testGrant(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "none" })}.${b64({ sub: "component:agent:mem-1", tenant: "t", mission_id: "m-1", task_id: "t-1", exp: 0 })}.sig`
}

interface Platform {
  url: string
  endpoint: string
  heartbeats: string[]
  close: () => Promise<void>
}

/** The daemon's edge: gRPC over TLS with the leaf, serving the two RPCs the member needs. */
async function platform(pki: TestPki): Promise<Platform> {
  const heartbeats: string[] = []
  const handler = connectNodeAdapter({
    routes: (router) => {
      router.service(ComponentService, {
        heartbeat: async (req) => {
          heartbeats.push(req.instanceId)
          return { registered: true }
        },
      })
      router.service(HarnessCallbackService, {
        async *subscribeInput() {
          yield { input: { jobId: "job-1", message: "hello from the daemon", grant: "" } }
        },
      })
    },
  })
  const server: Http2SecureServer = createSecureServer({ key: pki.leafKey, cert: pki.leafPem }, handler)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  const endpoint = `127.0.0.1:${address.port}`
  return {
    url: `https://${endpoint}`,
    endpoint,
    heartbeats,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const status = (): MemberStatus => ({ memberId: "mem-1", bankId: "bank-1", state: "idle", jobsInFlight: 0, cap: 1, jobs: [], claudeCodeVersion: "2.1.257", signInExpiresInDays: -1 })

const memberEnv = (endpoint: string, stateDir: string) => ({
  memberId: "mem-1",
  bankId: "bank-1",
  baseGrant: testGrant(),
  callbackEndpoint: endpoint,
  callbackInsecure: false,
  instanceMode: "member" as const,
  missionId: "m-1",
  sandbox: "gvisor" as const,
  loginShape: "api-key" as const,
  model: "",
  jobCap: 1,
  workspace: "/workspace",
  workspaceCapBytes: 1,
  stateDir,
  claudeBin: "claude",
  maxTurns: 1,
  maxBudgetUsd: undefined,
  mcpUrl: "",
  staleLimitMs: 1,
  heartbeatMs: 1,
  claudeConfigDir: join(stateDir, "claude-config"),
})

test("a set variable is written to platform-ca.pem under the state dir, mode 0600, and trusted beside the public roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-ca-"))
  try {
    const { caPem } = mintPki(dir)
    const stateDir = join(dir, "state", "nested")
    const trust = await platformTrust({ [PLATFORM_CA_ENV]: caPem }, stateDir)
    assert.ok(trust)
    assert.equal(trust.file, join(stateDir, PLATFORM_CA_FILE))
    assert.equal(((await stat(trust.file)).mode & 0o777).toString(8), "600")
    assert.equal(await readFile(trust.file, "utf8"), caPem)
    assert.ok(trust.ca.length > 1, "the public roots are retained")
    assert.equal(trust.ca.at(-1), caPem.trim(), "the platform CA is appended")
    assert.equal(await platformTrust({}, stateDir), undefined, "unset means public roots only")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("an empty value, a value that is not PEM, or a key is refused with the reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-ca-"))
  try {
    await assert.rejects(writePlatformCa("", dir), /is set but empty/)
    await assert.rejects(writePlatformCa("   \n", dir), /is set but empty/)
    await assert.rejects(writePlatformCa("not a certificate", dir), /not PEM/)
    await assert.rejects(writePlatformCa("-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n", dir), /does not parse/)
    const { leafKey, caPem } = mintPki(dir)
    await assert.rejects(writePlatformCa(leafKey, dir), /PRIVATE KEY block/)
    await assert.rejects(writePlatformCa(`${caPem}${leafKey}`, dir), /PRIVATE KEY block/)
    assert.equal(certificateBlocks(`${caPem}\n${caPem}`).length, 2, "a bundle of certificates is fine")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the children get NODE_EXTRA_CA_CERTS at the written file and never the PEM", () => {
  const env = { PATH: "/usr/bin", HOME: "/home/claude", GIBSON_CG_JWT: "g", [PLATFORM_CA_ENV]: "-----BEGIN CERTIFICATE-----" }
  const trust = { file: "/state/platform-ca.pem", ca: [] }
  const withCa = childEnv(env, trust)
  assert.equal(withCa[EXTRA_CA_CERTS_ENV], "/state/platform-ca.pem")
  assert.equal(withCa[PLATFORM_CA_ENV], undefined)
  assert.equal(withCa.GIBSON_CG_JWT, "g", "the MCP server still gets its base grant")
  const claude = claudeChildEnv(withCa, {})
  assert.equal(claude[EXTRA_CA_CERTS_ENV], "/state/platform-ca.pem", "the claude allow list passes NODE_ names")
  assert.equal(claude[PLATFORM_CA_ENV], undefined)
  const without = childEnv(env, undefined)
  assert.equal(without[EXTRA_CA_CERTS_ENV], undefined, "no CA, no file")
  assert.equal(without[PLATFORM_CA_ENV], undefined)
  assert.equal(without.PATH, "/usr/bin")
})

test("with the variable set the heartbeat and the inbox subscription verify a private edge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-ca-"))
  const pki = mintPki(dir)
  const edge = await platform(pki)
  try {
    const trust = await platformTrust({ [PLATFORM_CA_ENV]: pki.caPem }, join(dir, "state"))
    const beat = new ComponentHeartbeat({ component: openComponentClient(edge.url, () => "grant", trust), instanceId: "mem-1" })
    await beat.reportStatus(status())
    assert.deepEqual(edge.heartbeats, ["mem-1"])

    const harness = openHarness(memberEnv(edge.endpoint, dir), trust)
    try {
      const inbox = new HarnessInbox({ harness, memberId: "mem-1", spec: specOptionsFor(), sleep: async () => {} })
      const received: JobInput[] = []
      const controller = new AbortController()
      await inbox.subscribe(async (input) => {
        received.push(input)
        controller.abort()
      }, controller.signal)
      assert.equal(received.length, 1)
      assert.equal(received[0]!.jobId, "job-1")
      assert.equal(received[0]!.text, "hello from the daemon")
    } finally {
      harness.stop()
    }
  } finally {
    await edge.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("without the variable both fail with unable to verify the first certificate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-ca-"))
  const pki = mintPki(dir)
  const edge = await platform(pki)
  try {
    const beat = new ComponentHeartbeat({ component: openComponentClient(edge.url, () => "grant"), instanceId: "mem-1" })
    await assert.rejects(beat.reportStatus(status()), /unable to verify the first certificate/)
    assert.deepEqual(edge.heartbeats, [])

    const harness = openHarness(memberEnv(edge.endpoint, dir), undefined)
    try {
      await assert.rejects(
        (async () => {
          for await (const _ of harness.client.subscribeInput({ context: harness.context })) {
            // never reached
          }
        })(),
        /unable to verify the first certificate/,
      )
    } finally {
      harness.stop()
    }
  } finally {
    await edge.close()
    await rm(dir, { recursive: true, force: true })
  }
})
