// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  assertSubscriptionOnly,
  parseAuthStatus,
  parseAuthUrl,
  parseCodePrompt,
  parseExpiryWarning,
  parseInvalidCode,
  readAuthStatus,
  SignIn,
  SignInError,
  type AuthStatus,
  type SignInPrompt,
  type SignInRelay,
} from "./signin.js"

const FAKE = fileURLToPath(new URL("../test/bin/fake-claude-auth.mjs", import.meta.url))

class FakeRelay implements SignInRelay {
  prompts: SignInPrompt[] = []
  invalid: string[] = []
  signedIn: AuthStatus[] = []
  failed: string[] = []
  async reportPrompt(p: SignInPrompt): Promise<void> {
    this.prompts.push(p)
  }
  async reportInvalidCode(m: string): Promise<void> {
    this.invalid.push(m)
  }
  async reportSignedIn(s: AuthStatus): Promise<void> {
    this.signedIn.push(s)
  }
  async reportFailed(r: string): Promise<void> {
    this.failed.push(r)
  }
}

test("the spike's stdout lines parse into the URL and the paste prompt", () => {
  assert.equal(
    parseAuthUrl("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc"),
    "https://claude.com/cai/oauth/authorize?code=true&client_id=abc",
  )
  assert.equal(parseAuthUrl("Opening browser to sign in…"), "")
  assert.equal(parseCodePrompt("Paste code here if prompted > "), "Paste code here if prompted >")
  assert.equal(parseCodePrompt("Signed in."), "")
})

test("a refused code is read from stderr, and it does not end the attempt", () => {
  assert.equal(parseInvalidCode("Invalid code. Please make sure the full code was copied."), "Invalid code. Please make sure the full code was copied.")
  assert.equal(parseInvalidCode("some other warning"), "")
})

test("the expiry warning gives the days left", () => {
  assert.equal(parseExpiryWarning("Warning: login expires in 3 days"), 3)
  assert.equal(parseExpiryWarning("login expires in 1 day"), 1)
  assert.equal(parseExpiryWarning("nothing about expiry"), -1)
})

test("auth status parses the logged-in shape, and anything else is not logged in", () => {
  const s = parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","expiresAt":"2026-12-01T00:00:00.000Z"}')
  assert.equal(s.loggedIn, true)
  assert.equal(s.authMethod, "claude.ai")
  assert.equal(s.subscriptionType, "max")
  assert.equal(s.expiresAt, Date.parse("2026-12-01T00:00:00.000Z"))
  assert.equal(parseAuthStatus('{"loggedIn":false}').loggedIn, false)
  assert.equal(parseAuthStatus("not json").loggedIn, false, "an unreadable status is never a login")
  assert.equal(parseAuthStatus("").loggedIn, false)
})

test("a member on a subscription refuses to start with an Anthropic key set", () => {
  assert.throws(() => assertSubscriptionOnly({ ANTHROPIC_API_KEY: "sk-ant" }), SignInError)
  assert.throws(() => assertSubscriptionOnly({ ANTHROPIC_AUTH_TOKEN: "t" }), /would win over the person's login/)
  assert.doesNotThrow(() => assertSubscriptionOnly({ PATH: "/usr/bin" }))
})

test("readAuthStatus runs the real argv against the fake CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-auth-"))
  try {
    const state = join(dir, "state")
    const before = await readAuthStatus(FAKE, { ...process.env, FAKE_AUTH_STATE: state }, dir)
    assert.equal(before.loggedIn, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a full sign-in: the URL and the prompt relay, a wrong code is reported, the right one signs in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-auth-"))
  try {
    const relay = new FakeRelay()
    const env = { ...process.env, FAKE_AUTH_STATE: join(dir, "state"), FAKE_AUTH_CODE: "the-right-code" }
    const signIn = new SignIn({ bin: FAKE, env, cwd: dir, relay, pollMs: 50, deadlineMs: 10_000 })
    await signIn.start()

    for (let i = 0; i < 100 && relay.prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(relay.prompts.length, 1)
    assert.match(relay.prompts[0]!.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize/)
    assert.match(relay.prompts[0]!.codePrompt, /Paste code here/)

    signIn.submitCode("wrong-code")
    for (let i = 0; i < 100 && relay.invalid.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    assert.match(relay.invalid[0]!, /Invalid code/)
    assert.equal(relay.signedIn.length, 0, "a refused code is not a login")

    signIn.submitCode("the-right-code")
    assert.equal(await signIn.done, true)
    assert.equal(relay.signedIn.length, 1)
    assert.equal(relay.signedIn[0]!.authMethod, "claude.ai")
    assert.equal(relay.signedIn[0]!.subscriptionType, "max")
    assert.equal(relay.failed.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a sign-in that never completes fails on its deadline, and the person is told", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-auth-"))
  try {
    const relay = new FakeRelay()
    const signIn = new SignIn({ bin: FAKE, env: { ...process.env, FAKE_AUTH_STATE: join(dir, "state") }, cwd: dir, relay, pollMs: 50, deadlineMs: 300 })
    await signIn.start()
    assert.equal(await signIn.done, false)
    assert.match(relay.failed[0]!, /did not complete within 300ms/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cancel ends the attempt and reports it once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-auth-"))
  try {
    const relay = new FakeRelay()
    const signIn = new SignIn({ bin: FAKE, env: { ...process.env, FAKE_AUTH_STATE: join(dir, "state") }, cwd: dir, relay, pollMs: 50, deadlineMs: 10_000 })
    await signIn.start()
    signIn.cancel()
    assert.equal(await signIn.done, false)
    assert.deepEqual(relay.failed, ["sign-in cancelled"])
    assert.throws(() => signIn.submitCode("late"), SignInError)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a missing CLI fails the attempt instead of hanging", async () => {
  const relay = new FakeRelay()
  const signIn = new SignIn({ bin: "/nonexistent/claude", env: {}, cwd: process.cwd(), relay, pollMs: 50, deadlineMs: 5000 })
  await signIn.start()
  assert.equal(await signIn.done, false)
  assert.match(relay.failed[0]!, /cannot run \/nonexistent\/claude/)
})

test("no code path reads, copies or logs the credentials file", () => {
  // The credential is the person's, it lives on the sandbox's ephemeral disk,
  // and the platform never sees it (epic decision 8). This is the grep the
  // acceptance asks for, run as a test so it cannot rot.
  const dir = fileURLToPath(new URL(".", import.meta.url))
  const sources = readdirSync(dir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
  for (const file of sources) {
    const body = readFileSync(join(dir, file), "utf8")
    assert.ok(!body.includes(".credentials.json"), `${file} must not touch the credentials file`)
    assert.ok(!/ANTHROPIC_API_KEY["'\s]*\]?\s*\)?\s*\)?\s*\+/.test(body), `${file} must not concatenate an Anthropic key into a string`)
  }
})

test("the relayed prompt is the only place the URL appears, and the log seam never receives it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-auth-"))
  try {
    const relay = new FakeRelay()
    const logged: string[] = []
    const signIn = new SignIn({ bin: FAKE, env: { ...process.env, FAKE_AUTH_STATE: join(dir, "state"), FAKE_AUTH_CODE: "c" }, cwd: dir, relay, pollMs: 50, deadlineMs: 5000, log: (l) => logged.push(l) })
    await signIn.start()
    for (let i = 0; i < 100 && relay.prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    signIn.submitCode("c")
    await signIn.done
    assert.ok(!logged.some((l) => l.includes("https://")), "the URL never reaches the log")
    assert.ok(!logged.some((l) => l.includes("c\n")), "the code never reaches the log")
    const state = await readFile(join(dir, "state"), "utf8")
    assert.equal(state.trim(), "in")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
