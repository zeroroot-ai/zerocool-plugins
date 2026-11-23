// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { PLATFORM_URL_ENV, runMember } from "./member-main.js"

test("a member with no platform url refuses to start, because the bank would never learn its state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-main-"))
  const env = {
    GIBSON_MEMBER_ID: "mem-1",
    GIBSON_BANK_ID: "bank-1",
    GIBSON_CG_JWT: "base-grant",
    GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
    GIBSON_SANDBOX: "launcher",
    ZEROCOOL_STATE_DIR: join(dir, "state"),
  }
  const harness = { client: {}, transport: undefined, endpoint: "gibson:50001", context: {}, token: () => "base-grant", expiresAt: () => 0, stop: () => {} } as never
  try {
    await assert.rejects(runMember({ env, harness }, new AbortController().signal), new RegExp(`${PLATFORM_URL_ENV} is not set`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a subscription member refuses to start with an Anthropic key set", async () => {
  const env = {
    GIBSON_MEMBER_ID: "mem-1",
    GIBSON_BANK_ID: "bank-1",
    GIBSON_CG_JWT: "base-grant",
    GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
  GIBSON_SANDBOX: "launcher",
    GIBSON_PLATFORM_URL: "https://api.example",
    ZEROCOOL_LOGIN_SHAPE: "subscription",
    ANTHROPIC_API_KEY: "sk-ant",
  }
  await assert.rejects(runMember({ env }, new AbortController().signal), /would win over the person's login/)
})

test("a member with a job cap above one refuses to start, because fetch_file is wired", async () => {
  const env = {
    GIBSON_MEMBER_ID: "mem-1",
    GIBSON_BANK_ID: "bank-1",
    GIBSON_CG_JWT: "base-grant",
    GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
    GIBSON_SANDBOX: "launcher",
    GIBSON_PLATFORM_URL: "https://api.example",
    ZEROCOOL_JOB_CAP: "2",
  }
  await assert.rejects(runMember({ env }, new AbortController().signal), /ZEROCOOL_JOB_CAP is 2, and fetch_file is wired.*Set ZEROCOOL_JOB_CAP to 1/)
})
