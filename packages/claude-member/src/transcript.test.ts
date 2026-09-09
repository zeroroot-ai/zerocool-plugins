// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { archiveTranscript, chunk, chunkKey, findTranscriptFiles, projectDir, projectKey, restoreTranscript, transcriptOnDisk, type SessionStore } from "./transcript.js"

/** An in-memory session store, with a call log. */
function memoryStore(): SessionStore & { blobs: Map<string, Uint8Array>; puts: string[] } {
  const blobs = new Map<string, Uint8Array>()
  const puts: string[] = []
  return {
    blobs,
    puts,
    async put(key, data) {
      puts.push(key)
      blobs.set(key, new Uint8Array(data))
    },
    async get(key) {
      return blobs.get(key)
    },
  }
}

/** Lay a session down the way Claude Code 2.1.257 does. */
async function claudeWrote(configDir: string, cwd: string, sessionId: string, body: string, subagent?: string): Promise<string> {
  const dir = projectDir(configDir, cwd)
  await mkdir(dir, { recursive: true })
  const main = join(dir, `${sessionId}.jsonl`)
  await writeFile(main, body)
  if (subagent) {
    await mkdir(join(dir, sessionId, "subagents"), { recursive: true })
    await writeFile(join(dir, sessionId, "subagents", "agent-1.jsonl"), subagent)
  }
  return main
}

test("the project key is the working directory with slashes and dots turned into dashes, as measured", () => {
  // Measured against a real 2.1.257 capture. The path carries every character
  // the encoding touches: a leading slash, an inner slash, a hyphen already in
  // a segment, a dot inside a segment, and an upper-case segment.
  assert.equal(projectKey("/srv/work/Code/demo-app.v2/repo"), "-srv-work-Code-demo-app-v2-repo")
  assert.equal(projectDir("/cfg", "/workspace/jobs/job-1/api"), "/cfg/projects/-workspace-jobs-job-1-api")
})

test("chunks stay under the store's limit and an empty file is one empty chunk", () => {
  const big = new Uint8Array(2.5 * 1024 * 1024)
  const pieces = chunk(big)
  assert.equal(pieces.length, 3)
  assert.ok(pieces.every((p) => p.byteLength < 1024 * 1024))
  assert.equal(pieces.reduce((n, p) => n + p.byteLength, 0), big.byteLength)
  assert.equal(chunk(new Uint8Array(0)).length, 1)
  assert.equal(chunkKey("job-1", 3), "job-1/3")
})

test("the session's files are found under its own project directory, subagents included", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zc-transcript-"))
  try {
    await claudeWrote(dir, "/w/one", "sess-1", "main", "sub")
    await claudeWrote(dir, "/w/one", "sess-other", "other")
    const files = await findTranscriptFiles(dir, "/w/one", "sess-1")
    assert.equal(files.length, 2)
    assert.ok(files.some((f) => f.endsWith("sess-1.jsonl")))
    assert.ok(files.some((f) => f.includes("/sess-1/subagents/")))
    assert.deepEqual(await findTranscriptFiles(dir, "/w/one", ""), [], "no session id, nothing to find")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a session recorded under another working directory is still found, as --resume would", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zc-transcript-"))
  try {
    await claudeWrote(dir, "/w/elsewhere", "sess-1", "main")
    const files = await findTranscriptFiles(dir, "/w/here", "sess-1")
    assert.equal(files.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("archive then restore round-trips the transcript, in chunks, and gives back the session id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zc-transcript-"))
  try {
    const body = "x".repeat(1024 * 1024 + 10)
    const main = await claudeWrote(dir, "/w/one", "sess-1", body, "sub")
    const store = memoryStore()
    const manifest = await archiveTranscript({ store, jobId: "job-1", configDir: dir, cwd: "/w/one", sessionId: "sess-1", clock: () => 7 })
    assert.ok(manifest)
    assert.equal(manifest.sessionId, "sess-1")
    assert.equal(manifest.files.length, 2)
    const mainEntry = manifest.files.find((f) => f.path.endsWith("sess-1.jsonl"))!
    assert.equal(mainEntry.chunks.length, 2, "just over 1 MiB is two chunks")
    assert.equal(store.puts.at(-1), "job-1", "the manifest is written last, so a reader never sees a half archive")
    assert.ok(store.puts.slice(0, -1).every((k) => k.startsWith("job-1/")))

    // A relaunched member has a clean config dir.
    const fresh = await mkdtemp(join(tmpdir(), "zc-transcript-fresh-"))
    try {
      assert.equal(await transcriptOnDisk(fresh, "/w/one", "sess-1"), false)
      const sessionId = await restoreTranscript({ store, jobId: "job-1", configDir: fresh })
      assert.equal(sessionId, "sess-1")
      assert.equal(await transcriptOnDisk(fresh, "/w/one", "sess-1"), true)
      const restored = await readFile(join(projectDir(fresh, "/w/one"), "sess-1.jsonl"), "utf8")
      assert.equal(restored, body, "byte for byte, across the chunk boundary")
      assert.equal(await readFile(join(projectDir(fresh, "/w/one"), "sess-1", "subagents", "agent-1.jsonl"), "utf8"), "sub")
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
    assert.ok(main)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("archiving a job that never ran a turn stores nothing and says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zc-transcript-"))
  try {
    const store = memoryStore()
    assert.equal(await archiveTranscript({ store, jobId: "job-1", configDir: dir, cwd: "/w", sessionId: "never" }), undefined)
    assert.equal(store.puts.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("restoring a job the store does not know is nothing, and a broken manifest is an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zc-transcript-"))
  try {
    const store = memoryStore()
    assert.equal(await restoreTranscript({ store, jobId: "job-9", configDir: dir }), undefined)
    store.blobs.set("job-9", new TextEncoder().encode("{not json"))
    await assert.rejects(restoreTranscript({ store, jobId: "job-9", configDir: dir }), /not a transcript manifest/)
    store.blobs.set("job-8", new TextEncoder().encode(JSON.stringify({ version: 1, sessionId: "s", cwd: "/w", files: [{ path: "x/s.jsonl", bytes: 1, chunks: ["job-8/0"] }], archivedAt: 1 })))
    await assert.rejects(restoreTranscript({ store, jobId: "job-8", configDir: dir }), /chunk job-8\/0 is missing/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
