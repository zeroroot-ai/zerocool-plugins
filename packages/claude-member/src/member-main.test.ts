// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import type { Credential } from "@zeroroot-ai/sdk/gen/gibson/harness/v1/harness_callback_pb.js"
import type { JobSpec as WireJobSpec } from "@zeroroot-ai/sdk/gen/gibson/job/v1/job_pb.js"
import { credentialResolver, DEFAULT_CONNECTOR_BASE_URL, PLATFORM_URL_ENV, readGitSecret, runMember, specOptionsFor } from "./member-main.js"

const spec = (context: Record<string, unknown> = {}): WireJobSpec =>
  ({ $typeName: "gibson.job.v1.JobSpec", goal: "g", repositories: [], credentialNames: [], inputs: [], context }) as never

test("a connector's credential name and base url come from the job context, with a convention as the default", () => {
  const opts = specOptionsFor()
  assert.equal(opts.credentialFor("gitlab/acme", spec()), "acme-connector-cred")
  assert.equal(opts.baseUrlFor("gitlab/acme", spec()), DEFAULT_CONNECTOR_BASE_URL)
  assert.equal(opts.baseUrlFor("gitlab/acme", spec({ "connector.gitlab/acme.base_url": { stringValue: "https://git.acme" } })), "https://git.acme")
  assert.equal(opts.credentialFor("gitlab/acme", spec({ "connector.gitlab/acme.credential": { stringValue: "acme-pat" } })), "acme-pat")
  assert.equal(specOptionsFor({ baseUrl: "https://git.example" }).baseUrlFor("gitlab/acme", spec()), "https://git.example")
})

test("a git secret reads out of every shape a token is stored in", () => {
  const cred = (secretData: unknown): Credential => ({ $typeName: "gibson.harness.v1.Credential", name: "n", type: 0, secretData }) as never
  assert.deepEqual(readGitSecret("n", cred({ case: "apiKey", value: "glpat-1" })), { username: "oauth2", token: "glpat-1" })
  assert.deepEqual(readGitSecret("n", cred({ case: "bearerToken", value: "glpat-2" })), { username: "oauth2", token: "glpat-2" })
  assert.deepEqual(readGitSecret("n", cred({ case: "customSecret", value: "glpat-3" })), { username: "oauth2", token: "glpat-3" })
  assert.deepEqual(readGitSecret("n", cred({ case: "basic", value: { username: "ci", password: "glpat-4" } })), { username: "ci", token: "glpat-4" })
})

test("a credential that is not a git secret is refused, never guessed at", () => {
  assert.throws(() => readGitSecret("gitlab-token", undefined), /no usable git secret/)
  assert.throws(() => readGitSecret("gitlab-token", { $typeName: "gibson.harness.v1.Credential", name: "n", type: 0, secretData: { case: "oauth", value: {} } } as never), /no usable git secret/)
})

test("the resolver raises the daemon's refusal with the credential name", async () => {
  const harness = { client: { getCredential: async () => ({ error: { message: "not granted" } }) }, context: {} } as never
  await assert.rejects(credentialResolver(harness)("gitlab-token"), /GetCredential\(gitlab-token\) refused: not granted/)
})

test("a member with no platform url refuses to start, because the bank would never learn its state", async () => {
  const env = {
    GIBSON_MEMBER_ID: "mem-1",
    GIBSON_BANK_ID: "bank-1",
    GIBSON_CG_JWT: "base-grant",
    GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
  }
  const harness = { client: {}, transport: undefined, endpoint: "gibson:50001", context: {}, token: () => "base-grant", expiresAt: () => 0, stop: () => {} } as never
  await assert.rejects(runMember({ env, harness }, new AbortController().signal), new RegExp(`${PLATFORM_URL_ENV} is not set`))
})

test("a subscription member refuses to start with an Anthropic key set", async () => {
  const env = {
    GIBSON_MEMBER_ID: "mem-1",
    GIBSON_BANK_ID: "bank-1",
    GIBSON_CG_JWT: "base-grant",
    GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
    GIBSON_PLATFORM_URL: "https://api.example",
    ZEROCOOL_LOGIN_SHAPE: "subscription",
    ANTHROPIC_API_KEY: "sk-ant",
  }
  await assert.rejects(runMember({ env }, new AbortController().signal), /would win over the person's login/)
})
