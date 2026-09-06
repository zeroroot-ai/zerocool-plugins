// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { MemberState as WireMemberState } from "@zeroroot-ai/sdk/gen/gibson/bank/v1/bank_pb.js"
import { ComponentHeartbeat, healthMessage, memberStatusMessage, wireMemberState } from "./heartbeat.js"
import type { MemberStatus } from "./inbox.js"

const status = (over: Partial<MemberStatus> = {}): MemberStatus => ({
  memberId: "mem-1",
  bankId: "bank-1",
  state: "idle",
  jobsInFlight: 0,
  cap: 2,
  jobs: [],
  claudeCodeVersion: "2.1.257",
  signInExpiresInDays: -1,
  ...over,
})

test("every member state maps to the wire enum", () => {
  assert.equal(wireMemberState("launching"), WireMemberState.LAUNCHING)
  assert.equal(wireMemberState("needs_sign_in"), WireMemberState.NEEDS_SIGN_IN)
  assert.equal(wireMemberState("idle"), WireMemberState.IDLE)
  assert.equal(wireMemberState("busy"), WireMemberState.BUSY)
  assert.equal(wireMemberState("draining"), WireMemberState.DRAINING)
  assert.equal(wireMemberState("dead"), WireMemberState.DEAD)
})

test("the wire status carries the jobs in flight, the cap, the job ids and the CLI version", () => {
  const msg = memberStatusMessage(status({ state: "busy", jobsInFlight: 2, jobs: ["job-1", "job-2"] }))
  assert.equal(msg.state, WireMemberState.BUSY)
  assert.equal(msg.jobsInFlight, 2)
  assert.equal(msg.cap, 2)
  assert.deepEqual(msg.activeJobIds, ["job-1", "job-2"])
  assert.equal(msg.claudeVersion, "2.1.257")
})

test("the health message carries what MemberStatus has no field for", () => {
  assert.equal(healthMessage(status({ state: "needs_sign_in" })), "waiting for a person to sign in")
  assert.equal(healthMessage(status({ signInExpiresInDays: 3 })), "sign-in expires in 3 days")
  assert.equal(healthMessage(status({ jobsInFlight: 1 })), "1 of 2 jobs in flight")
})

test("the heartbeat names the member instance and reports healthy", async () => {
  const calls: Record<string, unknown>[] = []
  const beat = new ComponentHeartbeat({ component: { heartbeat: async (r: Record<string, unknown>) => void calls.push(r) } as never, instanceId: "mem-1" })
  await beat.reportStatus(status({ state: "busy", jobsInFlight: 2, jobs: ["job-1"] }))
  assert.equal(calls[0]!.instanceId, "mem-1")
  assert.equal(calls[0]!.healthStatus, "healthy")
  assert.equal((calls[0]!.member as { state: number }).state, WireMemberState.BUSY)
})
