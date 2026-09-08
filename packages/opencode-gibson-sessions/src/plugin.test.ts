// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { sessionIdOf, sessionsPlugin } from "./index.js"
import type { HarnessClient } from "./store.js"
import { selectSessionStore } from "./store.js"

/**
 * The plugin: which mode it picks, and what standalone means.
 *
 * Standalone must be opencode, unchanged. A plugin that registers hooks and
 * then swallows every call inside them is a second code path pretending to be
 * one, and it is the shape the store seam is supposed to avoid.
 */

const fakeInput = {
  client: {
    session: {
      get: async () => ({ data: { id: "ses_1" } }),
      messages: async () => ({ data: [{ id: "m1" }] }),
    },
  },
} as never

const silent = (): void => {}

test("standalone registers no hooks at all", async () => {
  const hooks = await sessionsPlugin(fakeInput, { env: {}, log: silent })
  assert.deepEqual(Object.keys(hooks), [], "no platform means opencode's own storage and nothing else")
})

test("a platform URL with no host key stays standalone rather than spending a bootstrap token", async () => {
  const selected = await selectSessionStore({
    env: { GIBSON_PLATFORM_URL: "https://api.example:30443", GIBSON_HOST_KEY_PATH: "/nope/host.key" },
    hostKeyExists: () => false,
  })
  assert.equal(selected.mode, "standalone")
  assert.match(selected.reason, /has not checked in/)
})

test("a dispatched run mirrors on the task grant", async () => {
  const opened: string[] = []
  const selected = await selectSessionStore({
    env: { GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: "t" },
    openHarness: (opts) => {
      opened.push(opts.endpoint)
      return { client: {} as HarnessClient, stop: silent } as never
    },
  })
  assert.equal(selected.mode, "task")
  assert.deepEqual(opened, ["gibson:50001"])
})

test("the dispatched grant wins when a host key is also present", async () => {
  const selected = await selectSessionStore({
    env: {
      GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
      GIBSON_CALLBACK_TOKEN: "t",
      GIBSON_PLATFORM_URL: "https://api.example:30443",
    },
    hostKeyExists: () => true,
    openHarness: () => ({ client: {} as HarnessClient, stop: silent }) as never,
    openComponent: async () => {
      throw new Error("the component grant must not be opened when a dispatch grant is present")
    },
  })
  assert.equal(selected.mode, "task")
})

test("an endpoint with no token stays standalone rather than widening authority", async () => {
  const selected = await selectSessionStore({
    env: { GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_PLATFORM_URL: "https://api.example" },
    hostKeyExists: () => true,
  })
  assert.equal(selected.mode, "standalone")
  assert.match(selected.reason, /widen this run's authority/)
})

test("an interactive run mirrors on the component grant, on the host key already written", async () => {
  const selected = await selectSessionStore({
    env: { GIBSON_PLATFORM_URL: "https://api.example:30443", GIBSON_HOST_KEY_PATH: "/keys/host.key" },
    hostKeyExists: (p) => p === "/keys/host.key",
    openComponent: async (opts) => {
      assert.equal(opts.hostKeyPath, "/keys/host.key")
      assert.equal(opts.agentName, "zerocool")
      return {} as HarnessClient
    },
  })
  assert.equal(selected.mode, "component")
})

test("the event hook mirrors the session opencode named, and dispose flushes it", async () => {
  const puts: { sessionId: string; ifMatch: string }[] = []
  // A harness client with only the two session RPCs on it. Anything else this
  // plugin reached for would be a method it must never call.
  const client = {
    getSessionContext: async () => ({ data: new Uint8Array(), etag: "" }),
    putSessionContext: async (req: { sessionId: string; ifMatch: string }) => {
      puts.push({ sessionId: req.sessionId, ifMatch: req.ifMatch })
      return { etag: "v1" }
    },
  } as unknown as HarnessClient

  const hooks = await sessionsPlugin(fakeInput, {
    env: { GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: "t" },
    openHarness: () => ({ client, stop: silent }) as never,
    log: silent,
    reader: { read: async () => ({ session: { id: "ses_1" }, messages: [{ id: "m1" }] }) },
  })
  assert.ok(hooks.event)

  await hooks.event({ event: { type: "message.updated", properties: { info: { sessionID: "ses_1" } } } as never })
  await hooks.event({ event: { type: "session.updated", properties: { info: { id: "ses_1" } } } as never })
  // The debounce window has not elapsed, so nothing is on the wire yet.
  assert.deepEqual(puts, [])

  await hooks.dispose?.()
  assert.deepEqual(puts, [{ sessionId: "ses_1", ifMatch: "" }], "two events, one checkpoint")
})

test("restore reads the prior session GIBSON_OPENCODE_SESSION_ID names", async () => {
  const gets: string[] = []
  const blob = new TextEncoder().encode(
    JSON.stringify({ v: 1, sessionId: "ses_old", writtenAt: 1, session: {}, messages: [{ id: "a" }], dropped: 0 }),
  )
  const client = {
    getSessionContext: async (req: { sessionId: string }) => {
      gets.push(req.sessionId)
      return { data: blob, etag: "v3" }
    },
    putSessionContext: async () => ({ etag: "v4" }),
  } as unknown as HarnessClient

  await sessionsPlugin(fakeInput, {
    env: {
      GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
      GIBSON_CALLBACK_TOKEN: "t",
      GIBSON_OPENCODE_SESSION_ID: "ses_old",
    },
    openHarness: () => ({ client, stop: silent }) as never,
    log: silent,
  })

  assert.deepEqual(gets, ["ses_old"], "a continued session restores the version chain it left behind")
})

test("a start with no prior session id reads nothing", async () => {
  const gets: string[] = []
  const client = {
    getSessionContext: async (req: { sessionId: string }) => {
      gets.push(req.sessionId)
      return { data: new Uint8Array(), etag: "" }
    },
    putSessionContext: async () => ({ etag: "v1" }),
  } as unknown as HarnessClient

  await sessionsPlugin(fakeInput, {
    env: { GIBSON_CALLBACK_ENDPOINT: "gibson:50001", GIBSON_CALLBACK_TOKEN: "t" },
    openHarness: () => ({ client, stop: silent }) as never,
    log: silent,
  })
  assert.deepEqual(gets, [])
})

test("the session id comes off the event opencode sent, never a second identity", () => {
  assert.equal(sessionIdOf({ type: "session.updated", properties: { info: { id: "ses_a" } } }), "ses_a")
  assert.equal(sessionIdOf({ type: "message.updated", properties: { info: { sessionID: "ses_b" } } }), "ses_b")
  assert.equal(sessionIdOf({ type: "file.edited", properties: {} }), undefined)
  assert.equal(sessionIdOf(undefined), undefined)
})
