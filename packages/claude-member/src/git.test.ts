// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ensureAskpass, gitEnv, runGit, scrub } from "./git.js"

test("gitEnv puts the token in the environment of the git child only, behind askpass", () => {
  const env = gitEnv({ cwd: "/w", credential: { username: "oauth2", token: "glpat-secret" }, askpassPath: "/state/git-askpass.sh", env: { PATH: "/usr/bin" } })
  assert.equal(env.GIT_ASKPASS, "/state/git-askpass.sh")
  assert.equal(env.ZEROCOOL_GIT_USERNAME, "oauth2")
  assert.equal(env.ZEROCOOL_GIT_TOKEN, "glpat-secret")
  assert.equal(env.GIT_TERMINAL_PROMPT, "0", "a missing credential must fail, never hang")
})

test("a git run with no credential carries no askpass wiring, even when the parent has one", () => {
  const env = gitEnv({ cwd: "/w", env: { GIT_ASKPASS: "/leaked", ZEROCOOL_GIT_TOKEN: "leaked" } })
  assert.equal(env.GIT_ASKPASS, undefined)
  assert.equal(env.ZEROCOOL_GIT_TOKEN, undefined)
})

test("a credential without the helper path is refused rather than passed on argv", () => {
  assert.throws(() => gitEnv({ cwd: "/w", credential: { username: "u", token: "t" } }), /askpass helper path/)
})

test("the askpass helper holds no secret and is not world readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-askpass-"))
  try {
    const path = await ensureAskpass(dir)
    const body = await readFile(path, "utf8")
    assert.ok(!body.includes("glpat"), "the script reads the environment, it stores nothing")
    assert.match(body, /ZEROCOOL_GIT_TOKEN/)
    const mode = (await stat(path)).mode & 0o777
    assert.equal(mode, 0o700)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("scrub removes a credential a git message echoed back from a URL", () => {
  assert.equal(scrub("fatal: could not read https://oauth2:glpat-secret@git.example/a.git"), "fatal: could not read https://<redacted>@git.example/a.git")
})

test("a failing git command reports the argv and the scrubbed stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-git-"))
  try {
    await assert.rejects(runGit(["rev-parse", "--verify", "nope"], { cwd: dir }), /git rev-parse --verify nope exited/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
