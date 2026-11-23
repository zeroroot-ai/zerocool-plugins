// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import type { JobSpec } from "./job.js"
import { turnSystemPrompt } from "./prompt.js"

const spec: JobSpec = {
  jobId: "job-42",
  goal: "close the unauthenticated admin route",
  repositories: [{ name: "api", connectorRef: "gitlab/acme", project: "acme/api", baseBranch: "main", deliverable: "MERGE_REQUEST" }],
  credentialNames: ["gitlab-token", "sonar-token"],
  inputNodeIds: ["node-1"],
  acceptance: "the verifier finds no unauthenticated route",
  constraints: {},
}

test("the turn prompt names the job, the paths, the deliverable and the credential names", () => {
  const p = turnSystemPrompt(spec, [{ repository: "api", path: "/workspace/jobs/job-42/api", branch: "job/job-42", deliverable: "MERGE_REQUEST", notes: [] }])
  assert.match(p, /job job-42/)
  assert.match(p, /close the unauthenticated admin route/)
  assert.match(p, /\/workspace\/jobs\/job-42\/api on branch job\/job-42, deliverable MERGE_REQUEST/)
  assert.match(p, /gitlab-token, sonar-token/)
  assert.match(p, /the verifier finds no unauthenticated route/)
  assert.match(p, /node-1/)
})

test("the prompt states the push rule and the delivery limits, so the model never holds a token", () => {
  const p = turnSystemPrompt(spec, [])
  assert.match(p, /Never push: the worktree has no remote and no token/)
  assert.match(p, /opens one merge request from the files of the worktree at wrap-up/)
  assert.match(p, /at most 100 changed files, 1 MiB for one file and 8 MiB in all/)
})

test("the prompt says the worktree is sparse, names fetch_file and carries the notes", () => {
  const p = turnSystemPrompt(spec, [{ repository: "api", path: "/w/api", branch: "job/job-42", deliverable: "MERGE_REQUEST", notes: ["Your earlier edits to this repository were lost when the sandbox restarted."] }])
  assert.match(p, /sparse/)
  assert.match(p, /mcp__workspace__fetch_file/)
  assert.match(p, /Note for api: Your earlier edits to this repository were lost/)
})

test("the prompt tells the model a scorer closes the job", () => {
  assert.match(turnSystemPrompt(spec, []), /A scorer closes this job/)
})

test("the prompt carries no secret value, only credential names", () => {
  const p = turnSystemPrompt(spec, [])
  assert.ok(!p.includes("glpat"), "a token never reaches the prompt")
})
