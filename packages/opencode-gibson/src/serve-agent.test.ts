// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { EXTENSION_KEY, GRANT_RENEW_BEFORE_MS, startAgentWorker, type InstanceRef } from "@zeroroot-ai/sdk"

import { agentHandler, callbackEndpointOf } from "./serve-agent.js"

/** The agent worker submits an A2A Task. These tests drive the real SDK worker with a fake daemon. */

const PROBE_BIN = fileURLToPath(new URL("../test/bin/fake-opencode-probe.mjs", import.meta.url))
const ENDPOINT = "https://api.example.test:8443"

const jwt = (payload: Record<string, unknown>): string => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "EdDSA" })}.${b64(payload)}.sig`
}
const grantFor = (tag: string, expiresInMs = 30 * 60_000): string =>
  jwt({ sub: "component:agent:zerocool-opencode", mission_id: "m-1", task_id: "t-1", mission_run_id: "run-1", exp: Math.floor((Date.now() + expiresInMs) / 1000), tag })

const message = (goal: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      messageId: "m-1",
      taskId: "t-1",
      contextId: "c-1",
      role: "ROLE_USER",
      parts: [{ text: goal }],
      metadata: { [EXTENSION_KEY]: { mission_run_id: "run-1", agent_run_id: "ar-1", trace_id: "tr-1" } },
    }),
  )

interface Submitted {
  workId: string
  result: Uint8Array
  error?: { code: string; message: string }
}

type Task = { status?: { state?: string }; artifacts?: { parts?: { text?: string }[] }[]; metadata?: Record<string, unknown> }

/** Serve one work item, and return what the worker submitted for it. */
async function serve(
  taskGrant: string,
  renewGrant?: (cur: string) => Promise<string>,
): Promise<{ submitted: Submitted; text: string; errors: unknown[] }> {
  let served = false
  let done!: (s: Submitted) => void
  const submittedP = new Promise<Submitted>((r) => (done = r))
  const errors: unknown[] = []
  const component = {
    pollWork: async () => {
      if (served) return await new Promise<never>(() => {})
      served = true
      return { workId: "w-1", workType: "execute", context: {}, payload: message("scan the repo"), timeoutMs: 0n, taskGrant }
    },
    submitResult: async (r: Submitted) => done(r),
  } as unknown as Parameters<typeof startAgentWorker>[0]
  const ref = { current: () => "inst-1", renew: async () => "inst-1" } as unknown as InstanceRef
  const stop = startAgentWorker(component, ref, {
    handler: agentHandler({ callbackEndpoint: ENDPOINT }),
    onError: (e) => errors.push(e),
    renewGrant: renewGrant ?? (async () => { throw new Error("no renewal expected") }),
  })
  try {
    const submitted = await submittedP
    return { submitted, text: new TextDecoder().decode(submitted.result), errors }
  } finally {
    stop()
  }
}

/** What the fake opencode child saw: its environment and its arguments. It wrote them to a file. */
async function probeOf(out: string): Promise<{ env: Record<string, string | undefined>; argv: string[] }> {
  return JSON.parse(await readFile(out, "utf8")) as { env: Record<string, string | undefined>; argv: string[] }
}

/** A temp file for the probe to write, and the environment that points the probe at it. */
async function probeEnv(extra: Record<string, string | undefined> = {}): Promise<{ out: string; env: Record<string, string | undefined> }> {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-probe-"))
  const out = join(dir, "probe.json")
  return { out, env: { ZEROCOOL_OPENCODE_BIN: PROBE_BIN, ZEROCOOL_TEST_PROBE_OUT: out, ...extra } }
}

async function withChildEnv<T>(set: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(set)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test("the child gets the task grant and the endpoint in its environment, and no direct provider key", async () => {
  const grant = grantFor("first")
  const probe = await probeEnv({ ANTHROPIC_API_KEY: "sk-direct", OPENAI_API_KEY: "sk-direct" })
  await withChildEnv(probe.env, async () => {
    const { submitted, errors } = await serve(grant)
    assert.equal(submitted.error, undefined)
    assert.deepEqual(errors, [])
    const { env } = await probeOf(probe.out)
    assert.equal(env.GIBSON_CALLBACK_TOKEN, grant)
    assert.equal(env.GIBSON_CALLBACK_ENDPOINT, ENDPOINT)
    assert.equal(env.GIBSON_MISSION_RUN_ID, "run-1")
    assert.equal(env.GIBSON_AGENT_RUN_ID, "ar-1")
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.OPENAI_API_KEY, undefined)
  })
})

test("the child gets the renewed grant when the grant of the work item is near its expiry", async () => {
  const old = grantFor("old", 60_000)
  const fresh = grantFor("fresh")
  const seen: string[] = []
  const probe = await probeEnv()
  await withChildEnv(probe.env, async () => {
    await serve(old, async (cur) => (seen.push(cur), fresh))
    assert.equal((await probeOf(probe.out)).env.GIBSON_CALLBACK_TOKEN, fresh)
    assert.deepEqual(seen, [old])
  })
})

test("the grant is removed from the output and the metadata of the submitted Task", async () => {
  const grant = grantFor("in-output")
  const probe = await probeEnv()
  await withChildEnv(probe.env, async () => {
    const { submitted, text } = await serve(grant)
    assert.equal(submitted.error, undefined)
    assert.ok(!text.includes(grant), "the Task has no grant")
    assert.ok(text.includes("the grant is [task grant]"), "the grant is replaced, not dropped without a trace")
    assert.equal((JSON.parse(text) as Task).status?.state, "TASK_STATE_COMPLETED")
  })
})

test("the grant is removed from the error of a child that fails", async () => {
  const grant = grantFor("in-error")
  const probe = await probeEnv({ ZEROCOOL_TEST_PROBE_FAIL: "1" })
  await withChildEnv(probe.env, async () => {
    const { submitted, errors } = await serve(grant)
    assert.equal(submitted.error?.code, "EXECUTION_ERROR")
    assert.match(submitted.error?.message ?? "", /opencode exited 1: boom with \[task grant\]/)
    assert.ok(!(submitted.error?.message ?? "").includes(grant))
    for (const e of errors) assert.ok(!String((e as Error).message).includes(grant))
  })
})

test("a grant with less than one renewal window left after the renewal starts no child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-agent-"))
  const marker = join(dir, "started")
  const bin = join(dir, "opencode")
  await writeFile(bin, `#!/bin/sh\necho started > ${marker}\n`)
  await chmod(bin, 0o755)
  const near = grantFor("near", GRANT_RENEW_BEFORE_MS - 30_000)
  await withChildEnv({ ZEROCOOL_OPENCODE_BIN: bin }, async () => {
    // The renewal returns a grant that is still near its expiry.
    const { submitted } = await serve(near, async () => grantFor("still-near", GRANT_RENEW_BEFORE_MS - 20_000))
    assert.equal(submitted.error?.code, "EXECUTION_ERROR")
    assert.match(submitted.error?.message ?? "", /ends in less than 120 seconds/)
    assert.ok(!(submitted.error?.message ?? "").includes(near))
    await assert.rejects(() => readFile(marker), "no child ran")
  })
})

test("the grant is in no log line of the worker", async () => {
  const grant = grantFor("secret")
  const lines: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => void lines.push(a.join(" "))
  try {
    await withChildEnv((await probeEnv()).env, async () => {
      const { errors } = await serve(grant)
      for (const e of errors) lines.push(String((e as Error).message))
    })
  } finally {
    console.error = orig
  }
  assert.ok(!lines.some((l) => l.includes(grant)))
})

test("a work item with no grant fails and no child starts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-agent-"))
  const marker = join(dir, "started")
  const bin = join(dir, "opencode")
  await writeFile(bin, `#!/bin/sh\necho started > ${marker}\n`)
  await chmod(bin, 0o755)
  await withChildEnv({ ZEROCOOL_OPENCODE_BIN: bin }, async () => {
    const { submitted } = await serve("")
    assert.equal(submitted.error?.code, "EXECUTION_ERROR")
    await assert.rejects(() => readFile(marker), "no child ran")
  })
})

test("the callback endpoint is the endpoint the worker polls", () => {
  assert.equal(callbackEndpointOf({ GIBSON_PLATFORM_URL: "https://api.example.test/" }), "https://api.example.test")
  assert.equal(
    callbackEndpointOf({ GIBSON_PLATFORM_URL: "https://api.example.test", GIBSON_DAEMON_URL: "https://edge.example.test" }),
    "https://edge.example.test",
  )
  assert.throws(() => callbackEndpointOf({}), /GIBSON_PLATFORM_URL is required/)
})
