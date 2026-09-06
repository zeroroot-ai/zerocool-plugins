// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { keyFor, readAmbient, readLive, stateDir, type LiveState } from "./state.js"

/**
 * The server writes these files; this package only reads them. The test
 * writes them the way `@zeroroot-ai/gibson-mcp`'s `state.ts` does, so the
 * format stays the contract between the two packages.
 */
async function serverWrites(dir: string, cwd: string, files: { ambient?: string; live?: LiveState }): Promise<void> {
  if (files.ambient !== undefined) await writeFile(join(dir, `ambient-${keyFor(cwd)}.md`), files.ambient, { encoding: "utf8", mode: 0o600 })
  if (files.live) await writeFile(join(dir, `live-${keyFor(cwd)}.json`), JSON.stringify(files.live), { encoding: "utf8", mode: 0o600 })
}

test("the state directory is ~/.zerocool, the one the server writes to", () => {
  assert.equal(stateDir({ ZEROCOOL_STATE_DIR: "/state" }), "/state")
  assert.match(stateDir({ HOME: "/home/ana" }), /\.zerocool$/)
  assert.ok(!stateDir({ HOME: "/home/ana" }).endsWith("claude"), "the server is host-agnostic and writes one directory for every host")
})

test("the key is a hash of the working directory, so two checkouts never share a block", () => {
  assert.notEqual(keyFor("/a"), keyFor("/b"))
  assert.equal(keyFor("/a"), keyFor("/a"))
  assert.match(keyFor("/a"), /^[0-9a-f]{16}$/)
})

test("the ambient block reads back per working directory, and a missing file is nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zc-state-"))
  assert.equal(await readAmbient(dir, "/w"), "")
  await serverWrites(dir, "/w", { ambient: "block" })
  assert.equal(await readAmbient(dir, "/w"), "block")
  assert.equal(await readAmbient(dir, "/other"), "")
})

test("the live mission reads back, and an unreadable file fails open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zc-state-"))
  assert.equal(await readLive(dir, "/w"), undefined)
  const live: LiveState = { missionId: "m", workId: "w", endpoint: "d:443", token: "t", insecure: false, writtenAt: 1 }
  await serverWrites(dir, "/w", { live })
  assert.deepEqual(await readLive(dir, "/w"), live)
  await writeFile(join(dir, `live-${keyFor("/broken")}.json`), "{not json", "utf8")
  assert.equal(await readLive(dir, "/broken"), undefined, "a stale or half-written file must not break a session end")
})
