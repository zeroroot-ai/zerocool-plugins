// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ToolCallError, type ToolCaller } from "./connector-tools.js"
import type { JobRepository } from "./job.js"
import { assertGitArgument, cutBytes, DeliveryRefused, jobBranch, MAX_DESCRIPTION_BYTES, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, WorkspaceManager, worktreePath } from "./workspace.js"

/**
 * The tests use a fake connector that answers `list_tree`, `read_file` and
 * `open_merge_request` in the documented shapes (connectors v0.7.0). The git
 * commands are real, run on a local directory. There is no remote and no token.
 */
type Entry = { path: string; type: string; sha?: string; size?: number; mode?: string }

interface Call {
  grant: string
  connectorRef: string
  tool: string
  args: Record<string, unknown>
}

const blobSha = (c: string) => createHash("sha1").update(`blob ${Buffer.byteLength(c)}\0${c}`).digest("hex")

/** A fake forge. `files` can change during a test, to move the base branch. */
function forge(files: Record<string, string | { content: string; mode: string }>, over: { pageSize?: number; truncated?: boolean; extra?: Entry[]; refuse?: Record<string, string>; failOpen?: (n: number) => boolean; transient?: boolean; failRead?: (path: string) => boolean } = {}) {
  const calls: Call[] = []
  const content = (p: string) => (typeof files[p] === "string" ? (files[p] as string) : (files[p] as { content: string }).content)
  const modeOf = (p: string) => (typeof files[p] === "string" ? "100644" : (files[p] as { mode: string }).mode)
  let opens = 0
  const tools: ToolCaller = async (grant, connectorRef, tool, args) => {
    calls.push({ grant, connectorRef, tool, args })
    if (tool === "list_tree") {
      const all: Entry[] = [...Object.keys(files).sort().map((p) => ({ path: p, type: "file", sha: blobSha(content(p)), size: Buffer.byteLength(content(p)), mode: modeOf(p) })), ...(over.extra ?? [])]
      const size = over.pageSize ?? 1000
      const start = args.cursor ? Number(args.cursor) : 0
      return { project: args.project, ref: args.ref, path: "", next_cursor: start + size < all.length ? String(start + size) : "", truncated: over.truncated ?? false, reason: over.truncated ? "the host cut the list" : "", entries: all.slice(start, start + size) }
    }
    if (tool === "read_file") {
      const p = String(args.path)
      if (over.refuse?.[p]) throw new ToolCallError("read_file", over.refuse[p]!)
      if (over.failRead?.(p)) throw new Error(`read_file broke on ${p}`)
      if (files[p] === undefined) return { found: false }
      return { found: true, content: content(p), sha: blobSha(content(p)), path: p }
    }
    if (tool === "open_merge_request") {
      opens++
      if (over.failOpen?.(opens)) throw new ToolCallError("open_merge_request", "the host is busy", over.transient ?? true)
      return { merge_request: `acme/${args.project}#${opens}`, url: `https://git.example/${args.project}/pull/${opens}`, source_branch: args.branch, existing: false }
    }
    throw new Error(`unexpected tool ${tool}`)
  }
  return { tools, calls, files, byTool: (t: string) => calls.filter((c) => c.tool === t) }
}

const repo: JobRepository = { name: "api", connectorRef: "connector/acme", project: "acme/api", baseBranch: "main", deliverable: "MERGE_REQUEST" }
const wrap = { push: true, title: "job j1: fix the route", description: "the goal", grant: "wrap-grant" }

async function setup(files: Parameters<typeof forge>[0], over: Parameters<typeof forge>[1] = {}, opts: { live?: (g: string) => boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-ws-"))
  const f = forge(files, over)
  const ws = new WorkspaceManager({ root: dir, stateDir: join(dir, "state"), tools: f.tools, grantLive: opts.live ?? (() => true) })
  const fetch = (jobId: string, file: string, grant = "turn-grant", r = repo) => ws.fetchFile(jobId, [r], undefined, file, grant)
  return { dir, ws, fetch, ...f, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("prepare lists the whole tree, reads only the files the job names, and keeps the record outside the worktree", async () => {
  const s = await setup({ "README.md": "hello\n", "src/app.go": "package app\n", "src/other.go": "other\n" }, { pageSize: 2 })
  try {
    const [tree] = await s.ws.prepare("j1", [{ ...repo, paths: ["src/app.go", "nope.txt"] }], "turn-grant", { resumed: false })
    assert.equal(tree!.path, worktreePath(s.dir, "j1", "api"))
    assert.equal(tree!.branch, jobBranch("j1"))
    assert.equal(s.byTool("list_tree").length, 2, "the cursor pages the listing")
    assert.deepEqual(s.byTool("list_tree")[0]!.args, { project: "acme/api", ref: "main" })
    assert.deepEqual(s.byTool("read_file").map((c) => c.args.path), ["src/app.go"], "only the named file that the listing holds")
    assert.ok(s.calls.every((c) => c.grant === "turn-grant" && c.connectorRef === "connector/acme"))
    assert.equal(await readFile(join(tree!.path, "src/app.go"), "utf8"), "package app\n")
    await assert.rejects(stat(join(tree!.path, "README.md")), /ENOENT/, "a file the job does not name is not on disk")
    // The record is outside the work tree, and no git ref carries the base.
    assert.ok((await stat(join(s.dir, "state", "workspaces", "j1", "api.json"))).isFile())
    await assert.rejects(stat(join(tree!.path, ".git", "refs", "zerocool")), /ENOENT/)
  } finally {
    await s.cleanup()
  }
})

test("fetch_file reads under the current turn grant, writes the file and records its base", async () => {
  const s = await setup({ "a.txt": "a\n", "run.sh": { content: "#!/bin/sh\n", mode: "100755" } })
  try {
    await s.ws.prepare("j1", [repo], "grant-1", { resumed: false })
    const r = await s.fetch("j1", "a.txt", "grant-2")
    assert.equal(r.ok, true)
    assert.equal(s.byTool("read_file")[0]!.grant, "grant-2", "the grant of the call, not the grant of prepare")
    assert.equal(await readFile(join(worktreePath(s.dir, "j1", "api"), "a.txt"), "utf8"), "a\n")
    await s.fetch("j1", "run.sh")
    assert.ok(((await stat(join(worktreePath(s.dir, "j1", "api"), "run.sh"))).mode & 0o111) !== 0, "the listed mode is kept")
    assert.equal((await s.fetch("j1", "a.txt")).text.includes("already"), true)
    assert.equal(s.byTool("read_file").length, 2, "a second fetch of the same path reads nothing")
    assert.match((await s.fetch("j1", "new.txt")).text, /not in the repository.*Create it by writing the file/)
    assert.equal((await s.fetch("j1", "../x")).ok, false)
  } finally {
    await s.cleanup()
  }
})

test("a file that read_file refuses is never written, and the refusal goes back to Claude", async () => {
  const refuse = { "a.bin": "the file is not text", "big.txt": "the file is larger than 1 MiB", "enc.txt": 'the encoding is "none"' }
  const s = await setup({ "a.bin": "x", "big.txt": "y", "enc.txt": "z" }, { refuse })
  try {
    await s.ws.prepare("j1", [repo], "g", { resumed: false })
    for (const [p, text] of Object.entries(refuse)) {
      const r = await s.fetch("j1", p)
      assert.equal(r.ok, false)
      assert.ok(r.text.includes(text.slice(0, 12)), r.text)
      await assert.rejects(stat(join(worktreePath(s.dir, "j1", "api"), p)), /ENOENT/)
    }
    // Claude cannot write the refused path itself and deliver it.
    await writeFile(join(worktreePath(s.dir, "j1", "api"), "a.bin"), "mine")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.match(out!.error, /never fetched them with fetch_file: a\.bin/)
    assert.equal(s.byTool("open_merge_request").length, 0)
  } finally {
    await s.cleanup()
  }
})

test("fetch_file refuses when the file moved since the listing, and when the turn has no live grant", async () => {
  const s = await setup({ "a.txt": "a\n" }, {}, { live: (g) => g !== "dead" })
  try {
    await s.ws.prepare("j1", [repo], "g", { resumed: false })
    s.files["a.txt"] = "changed on the host\n"
    const moved = await s.fetch("j1", "a.txt")
    assert.equal(moved.ok, false)
    assert.match(moved.text, /The base branch moved: a\.txt/)
    const dead = await s.fetch("j1", "a.txt", "dead")
    assert.match(dead.text, /no live grant/)
    assert.equal((await s.ws.fetchFile("j1", [repo], undefined, "a.txt", undefined)).ok, false, "no grant at all")
  } finally {
    await s.cleanup()
  }
})

test("an edit, an add and a delete become one open_merge_request, and the base is read again first", async () => {
  const s = await setup({ "README.md": "hello\n", "src/old.go": "old\n", "src/keep.go": "keep\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "turn-grant", { resumed: false })
    await s.fetch("j1", "README.md")
    await s.fetch("j1", "src/old.go")
    await s.fetch("j1", "src/keep.go")
    await writeFile(join(tree!.path, "README.md"), "hello world\n")
    await writeFile(join(tree!.path, "later.txt"), "new\n")
    await mkdir(join(tree!.path, "src/sub"), { recursive: true })
    await writeFile(join(tree!.path, "src/sub/new.go"), "package sub\n")
    await unlink(join(tree!.path, "src/old.go"))
    const before = s.byTool("read_file").length

    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    const opened = s.byTool("open_merge_request")
    assert.equal(opened.length, 1, "one call")
    assert.equal(opened[0]!.grant, "wrap-grant")
    const args = opened[0]!.args as { files: { path: string; content?: string; delete?: boolean }[] }
    assert.deepEqual({ ...args, files: undefined }, { project: "acme/api", base_branch: "main", branch: "job/j1", title: "job j1: fix the route", description: "the goal", files: undefined })
    assert.deepEqual(
      [...args.files].sort((x, y) => (x.path < y.path ? -1 : 1)),
      [
        { path: "README.md", content: "hello world\n" },
        { path: "later.txt", content: "new\n" },
        { path: "src/old.go", delete: true },
        { path: "src/sub/new.go", content: "package sub\n" },
      ],
    )
    assert.equal(s.byTool("read_file").length - before, 4, "each changed path is read again before the open")
    assert.equal(out!.mergeRequest, "acme/acme/api#1")
    assert.equal(out!.mergeRequestUrl, "https://git.example/acme/api/pull/1")
    assert.equal(out!.error, "")
    assert.equal(out!.files, 4)
  } finally {
    await s.cleanup()
  }
})

test("a job with no change opens nothing, and an abandoned job opens nothing and says so", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await s.fetch("j1", "a.txt")
    const [none] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(s.byTool("open_merge_request").length, 0)
    assert.equal(none!.files, 0)
    await writeFile(join(worktreePath(s.dir, "j1", "api"), "b.txt"), "b\n")
    const [ab] = await s.ws.wrapUp("j1", [repo], { ...wrap, push: false, grant: undefined })
    assert.match(ab!.error, /abandoned: no merge request opened/)
    assert.equal(ab!.failed, false)
    assert.equal(s.byTool("open_merge_request").length, 0)
  } finally {
    await s.cleanup()
  }
})

test("PUSH_BRANCH is refused with a clear, permanent result", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const r = { ...repo, deliverable: "PUSH_BRANCH" as const }
    const [tree] = await s.ws.prepare("j1", [r], "g", { resumed: false })
    await writeFile(join(tree!.path, "b.txt"), "b\n")
    const [out] = await s.ws.wrapUp("j1", [r], wrap)
    assert.match(out!.error, /PUSH_BRANCH is not supported/)
    assert.equal(out!.retryable, false)
    assert.equal(s.byTool("open_merge_request").length, 0)
  } finally {
    await s.cleanup()
  }
})

/** The change is made in the work tree after a fetch of `a.txt`. The wrap-up must refuse it and open nothing. */
async function refuses(change: (dir: string) => Promise<void>, expected: RegExp, files: Parameters<typeof forge>[0] = { "a.txt": "a\n" }, over: Parameters<typeof forge>[1] = {}) {
  const s = await setup(files, over)
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    for (const p of Object.keys(files)) if (!over.refuse?.[p]) await s.fetch("j1", p)
    await change(tree!.path)
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(s.byTool("open_merge_request").length, 0, "nothing is delivered")
    assert.match(out!.error, expected)
    assert.equal(out!.failed, true)
    assert.equal(out!.retryable, false, "a refusal is permanent")
    assert.equal(out!.mergeRequestUrl, "")
  } finally {
    await s.cleanup()
  }
}

test("a listed path that was never fetched is refused, so a left-out file cannot be overwritten", async () => {
  const s = await setup({ "a.txt": "a\n", "other.txt": "o\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await writeFile(join(tree!.path, "other.txt"), "mine\n")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.match(out!.error, /never fetched them with fetch_file: other\.txt/)
    assert.equal(s.byTool("open_merge_request").length, 0)
  } finally {
    await s.cleanup()
  }
})

test("a path below a file, and a file where the repository has a folder, are refused", async () => {
  const s = await setup({ "docs": "i am a file\n", "src/a.go": "a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await mkdir(join(tree!.path, "docs"), { recursive: true })
    await writeFile(join(tree!.path, "docs/new.md"), "x\n")
    await writeFile(join(tree!.path, "src.txt"), "ok\n")
    await mkdir(join(tree!.path, "x"), { recursive: true })
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.match(out!.error, /docs\/new\.md \(below docs, which is a file\)/)
    assert.equal(s.byTool("open_merge_request").length, 0)
    await rm(join(tree!.path, "docs"), { recursive: true })
    await writeFile(join(tree!.path, "src"), "a file where the folder is\n")
    const [out2] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.match(out2!.error, /src \(the repository has a folder at that path\)/)
  } finally {
    await s.cleanup()
  }
})

test("a symbolic link, a submodule path and a listed symlink are refused", async () => {
  const s = await setup({ "a.txt": "a\n" }, { extra: [{ path: "ln", type: "symlink", mode: "120000" }, { path: "mod", type: "submodule", mode: "160000" }, { path: "mod2", type: "submodule", mode: "160000" }] })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await symlink("a.txt", join(tree!.path, "newlink"))
    await mkdir(join(tree!.path, "mod/inner"), { recursive: true })
    await writeFile(join(tree!.path, "mod/inner/x.txt"), "x\n")
    await writeFile(join(tree!.path, "ln"), "now a file\n")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.match(out!.error, /not regular files.*newlink/)
    assert.match(out!.error, /mod\/inner\/x\.txt \(below mod, which is a submodule\)/)
    assert.doesNotMatch(out!.error, /never fetched them.*\b(ln|mod)\b/, "a symlink or submodule is not a regular file, and is not a fetch you forgot")
    assert.match(out!.error, /ln \(the path is not a regular file: it is a symlink in the repository\)/)
    assert.equal(s.byTool("open_merge_request").length, 0)
  } finally {
    await s.cleanup()
  }
})

test("a moved base branch refuses the delivery for an edit, a delete and an add", async () => {
  const s = await setup({ "a.txt": "a\n", "b.txt": "b\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await s.fetch("j1", "a.txt")
    await s.fetch("j1", "b.txt")
    await writeFile(join(tree!.path, "a.txt"), "mine\n")
    await unlink(join(tree!.path, "b.txt"))
    await writeFile(join(tree!.path, "c.txt"), "new\n")
    s.files["a.txt"] = "moved\n"
    delete s.files["b.txt"]
    s.files["c.txt"] = "appeared on the host\n"
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.match(out!.error, /The base branch moved: a\.txt, b\.txt, c\.txt changed on main/)
    assert.equal(out!.retryable, false)
    assert.equal(s.byTool("open_merge_request").length, 0)
  } finally {
    await s.cleanup()
  }
})

test("a mode drop, a new executable and a mode raise are refused with the reason", async () => {
  const s = await setup({ "run.sh": { content: "#!/bin/sh\n", mode: "100755" }, "plain.txt": "p\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await s.fetch("j1", "run.sh")
    await s.fetch("j1", "plain.txt")
    await writeFile(join(tree!.path, "run.sh"), "#!/bin/sh\necho hi\n")
    await chmod(join(tree!.path, "run.sh"), 0o644)
    await chmod(join(tree!.path, "plain.txt"), 0o755)
    await writeFile(join(tree!.path, "tool.sh"), "x\n")
    await chmod(join(tree!.path, "tool.sh"), 0o755)
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.match(out!.error, /run\.sh \(100755 to 100644, and the tool would keep 100755\)/)
    assert.match(out!.error, /plain\.txt \(100644 to 100755/)
    assert.match(out!.error, /tool\.sh \(new executable file/)
    assert.equal(s.byTool("open_merge_request").length, 0)
  } finally {
    await s.cleanup()
  }
})

test("an edit of an executable file that keeps its mode is delivered", async () => {
  const s = await setup({ "run.sh": { content: "#!/bin/sh\n", mode: "100755" } })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await s.fetch("j1", "run.sh")
    await writeFile(join(tree!.path, "run.sh"), "#!/bin/sh\necho hi\n")
    await chmod(join(tree!.path, "run.sh"), 0o755)
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(out!.error, "")
    assert.deepEqual((s.byTool("open_merge_request")[0]!.args as { files: unknown[] }).files, [{ path: "run.sh", content: "#!/bin/sh\necho hi\n" }])
  } finally {
    await s.cleanup()
  }
})

test("a byte order mark stays in the content of an edit and of a new file", async () => {
  const s = await setup({ "bom.txt": "﻿first\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await s.fetch("j1", "bom.txt")
    assert.equal((await readFile(join(tree!.path, "bom.txt")))[0], 0xef, "the fetched file keeps its BOM")
    await writeFile(join(tree!.path, "bom.txt"), "﻿second\n")
    await writeFile(join(tree!.path, "new.txt"), "﻿new\n")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(out!.error, "")
    const files = (s.byTool("open_merge_request")[0]!.args as { files: { path: string; content: string }[] }).files
    assert.deepEqual(files.map((f) => [f.path, f.content.charCodeAt(0)]).sort(), [["bom.txt", 0xfeff], ["new.txt", 0xfeff]])
  } finally {
    await s.cleanup()
  }
})

test("more than 100 files, a file over 1 MiB, files over 8 MiB, and a binary file are refused with the limit", async () => {
  await refuses(async (dir) => {
    for (let i = 0; i <= MAX_FILES; i++) await writeFile(join(dir, `f${i}.txt`), "x\n")
  }, /101 files\. The limit of open_merge_request is 100/)
  await refuses(async (dir) => writeFile(join(dir, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1)), /big\.txt \(1048577 bytes\)/)
  await refuses(async (dir) => {
    for (let i = 0; i < 9; i++) await writeFile(join(dir, `m${i}.txt`), "x".repeat(MAX_FILE_BYTES))
  }, new RegExp(`add up to ${9 * MAX_FILE_BYTES} bytes\\. The limit for all files is ${MAX_TOTAL_BYTES}`))
  await refuses(async (dir) => writeFile(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0, 1, 2])), /not UTF-8 text.*logo\.png/)
  await refuses(async (dir) => writeFile(join(dir, "bad.txt"), Buffer.from([0xff, 0xfe, 0x41])), /not UTF-8 text.*bad\.txt/)
})

test("a truncated tree is refused, nothing is read, and no merge request opens", async () => {
  const s = await setup({ "a.txt": "a\n" }, { truncated: true })
  try {
    await assert.rejects(s.ws.prepare("j1", [{ ...repo, paths: ["a.txt"] }], "g", { resumed: false }), (e: Error) => e instanceof DeliveryRefused && /cut the tree of acme\/api at main \(the host cut the list/.test(e.message) && /partial tree is never delivered/.test(e.message))
    assert.equal(s.byTool("read_file").length, 0)
    assert.equal(s.byTool("open_merge_request").length, 0)
  } finally {
    await s.cleanup()
  }
})

test("a job with two repositories opens none when one is refused", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const second: JobRepository = { ...repo, name: "web", project: "acme/web" }
    const [t1, t2] = await s.ws.prepare("j1", [repo, second], "g", { resumed: false })
    await writeFile(join(t1!.path, "ok.txt"), "fine\n")
    await writeFile(join(t2!.path, "bad.bin"), Buffer.from([0, 1, 2]))
    const [o1, o2] = await s.ws.wrapUp("j1", [repo, second], wrap)
    assert.equal(s.byTool("open_merge_request").length, 0)
    assert.match(o2!.error, /not UTF-8 text/)
    assert.match(o1!.error, /a job delivers all of its repositories or none/)
    assert.equal(o1!.failed, true)
  } finally {
    await s.cleanup()
  }
})

test("a failed open after another opened reports the job as failed and names the opened merge request", async () => {
  const s = await setup({ "a.txt": "a\n" }, { failOpen: (n) => n === 2 })
  try {
    const second: JobRepository = { ...repo, name: "web", project: "acme/web" }
    const [t1, t2] = await s.ws.prepare("j1", [repo, second], "g", { resumed: false })
    await writeFile(join(t1!.path, "x.txt"), "x\n")
    await writeFile(join(t2!.path, "y.txt"), "y\n")
    const [o1, o2] = await s.ws.wrapUp("j1", [repo, second], wrap)
    assert.equal(o1!.mergeRequestUrl, "https://git.example/acme/api/pull/1")
    assert.equal(o2!.failed, true)
    assert.equal(o2!.retryable, true, "the same branch name makes a retry safe")
    assert.match(o2!.error, /the host is busy/)
    assert.match(o2!.error, /after these merge requests were opened: api: acme\/acme\/api#1 https:\/\/git\.example\/acme\/api\/pull\/1/)
  } finally {
    await s.cleanup()
  }
})

test("a relaunched job whose directory is gone gets a new workspace and a note that its edits were lost", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const [first] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    assert.deepEqual(first!.notes, [])
    await s.fetch("j1", "a.txt")
    await writeFile(join(first!.path, "a.txt"), "edited before the loss\n")
    await rm(first!.path, { recursive: true })
    const [again] = await s.ws.prepare("j1", [repo], "g", { resumed: true })
    assert.match(again!.notes[0]!, /earlier edits to this repository were lost.*Make the edits again/)
    await assert.rejects(stat(join(again!.path, "a.txt")), /ENOENT/, "the lost edit is not on disk")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(s.byTool("open_merge_request").length, 0, "a change set built before the loss is never delivered")
    assert.equal(out!.files, 0, "the new workspace holds no edit and no delete")
  } finally {
    await s.cleanup()
  }
})

test("a directory with no record is treated as lost, never trusted", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const [first] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await writeFile(join(first!.path, "stray.txt"), "no record\n")
    await rm(join(s.dir, "state"), { recursive: true })
    const fresh = new WorkspaceManager({ root: s.dir, stateDir: join(s.dir, "state"), tools: s.tools, grantLive: () => true })
    const [again] = await fresh.prepare("j1", [repo], "g", { resumed: true })
    assert.match(again!.notes[0]!, /were lost/)
    await assert.rejects(stat(join(again!.path, "stray.txt")), /ENOENT/)
  } finally {
    await s.cleanup()
  }
})

test("a turn with no live grant leaves the workspace unread, and a later turn reads it", async () => {
  const s = await setup({ "a.txt": "a\n" }, {}, { live: (g) => g === "live" })
  try {
    const [t] = await s.ws.prepare("j1", [{ ...repo, paths: ["a.txt"] }], undefined, { resumed: false })
    assert.match(t!.notes[0]!, /not read yet/)
    assert.equal(s.calls.length, 0, "no call runs without a grant of a turn")
    await writeFile(join(t!.path, "a.txt"), "written before the read\n")
    const [out] = await s.ws.wrapUp("j1", [{ ...repo }], { ...wrap, grant: "live" })
    assert.equal(out!.retryable, false)
    assert.match(out!.error, /the repository was not read/)
    await s.ws.prepare("j1", [{ ...repo, paths: ["a.txt"] }], "dead", { resumed: false })
    assert.equal(s.calls.length, 0, "an expired grant reads nothing")
    const [later] = await s.ws.prepare("j1", [{ ...repo, paths: ["a.txt"] }], "live", { resumed: false })
    assert.deepEqual(later!.notes, [])
    assert.equal(s.byTool("list_tree").length, 1)
  } finally {
    await s.cleanup()
  }
})

test("an expired or missing grant at wrap-up is permanent, and the work is not touched by wrapUp", async () => {
  const s = await setup({ "a.txt": "a\n" }, {}, { live: (g) => g === "live" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "live", { resumed: false })
    await writeFile(join(tree!.path, "b.txt"), "b\n")
    for (const grant of ["dead", undefined]) {
      const [out] = await s.ws.wrapUp("j1", [repo], { ...wrap, grant })
      assert.equal(out!.retryable, false, "no try inside the close brings an expired grant back")
      assert.equal(out!.failed, true)
      assert.match(out!.error, /No live grant of a turn of this job/)
    }
    assert.equal(s.byTool("open_merge_request").length, 0)
    assert.equal(await readFile(join(tree!.path, "b.txt"), "utf8"), "b\n", "the work is still there")
    const [ok] = await s.ws.wrapUp("j1", [repo], { ...wrap, grant: "live" })
    assert.equal(ok!.error, "")
    assert.equal(ok!.mergeRequest, "acme/acme/api#1")
  } finally {
    await s.cleanup()
  }
})

test("a permanent refusal of the tool is not retryable", async () => {
  const s = await setup({ "a.txt": "a\n" }, { failOpen: () => true, transient: false })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await writeFile(join(tree!.path, "b.txt"), "b\n")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(out!.failed, true)
    assert.equal(out!.retryable, false)
  } finally {
    await s.cleanup()
  }
})

test("a transient failure of the tool is retryable, with the same branch name on the retry", async () => {
  const s = await setup({ "a.txt": "a\n" }, { failOpen: (n) => n === 1 })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await writeFile(join(tree!.path, "b.txt"), "b\n")
    const [bad] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(bad!.retryable, true)
    const [good] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(good!.error, "")
    assert.deepEqual(s.byTool("open_merge_request").map((c) => c.args.branch), ["job/j1", "job/j1"])
  } finally {
    await s.cleanup()
  }
})

test("the description is cut at 20000 bytes on a character boundary, and the title at 256 bytes", async () => {
  const cut = cutBytes("é".repeat(30_000), MAX_DESCRIPTION_BYTES)
  assert.equal(Buffer.byteLength(cut), MAX_DESCRIPTION_BYTES)
  assert.equal(cut, "é".repeat(10_000))
  assert.equal(cutBytes("aé", 2), "a", "a two byte character is not split")
  const s = await setup({ "a.txt": "a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await writeFile(join(tree!.path, "b.txt"), "b\n")
    await s.ws.wrapUp("j1", [repo], { ...wrap, title: "é".repeat(400), description: "漢".repeat(20_000) })
    const args = s.byTool("open_merge_request")[0]!.args as { title: string; description: string }
    assert.ok(Buffer.byteLength(args.title) <= 256)
    assert.ok(Buffer.byteLength(args.description) <= MAX_DESCRIPTION_BYTES)
    assert.equal(args.description, "漢".repeat(6666))
  } finally {
    await s.cleanup()
  }
})

test("remove deletes the work tree and the record", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await s.ws.remove("j1", [repo])
    await assert.rejects(stat(join(s.dir, "jobs", "j1")), /ENOENT/)
    await assert.rejects(stat(join(s.dir, "state", "workspaces", "j1")), /ENOENT/)
  } finally {
    await s.cleanup()
  }
})

test("a job id, repository name or base branch git could read as an option or a path escape is refused", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    await assert.rejects(s.ws.prepare("--upload-pack=touch /tmp/pwned", [repo], "g", { resumed: false }), /job id .* starts with a dash/)
    await assert.rejects(s.ws.prepare("../escape", [repo], "g", { resumed: false }), /job id .* contains \.\./)
    await assert.rejects(s.ws.prepare("j1", [{ ...repo, name: "-x" }], "g", { resumed: false }), /repository name .* starts with a dash/)
    await assert.rejects(s.ws.prepare("j1", [{ ...repo, name: "a/b" }], "g", { resumed: false }), /repository name .* contains a slash/)
    await assert.rejects(s.ws.prepare("j1", [{ ...repo, baseBranch: "--upload-pack=x" }], "g", { resumed: false }), /base branch .* starts with a dash/)
    await assert.rejects(s.ws.remove("../escape", [repo]), /job id .* contains \.\./)
    assert.equal(assertGitArgument("base branch", "release/2026.09"), "release/2026.09")
    assert.equal(assertGitArgument("job id", "job_1.a-b", { path: true }), "job_1.a-b")
    assert.equal(s.calls.length, 0, "a refused argument calls no tool")
  } finally {
    await s.cleanup()
  }
})

// ---- .gitignore (N1)

const IGNORE = "dist/\nnode_modules/\ncoverage/\n__pycache__/\n.venv\n"

test("every listed .gitignore, root and nested, is fetched, and build output, a venv and a cache stay out of the change", async () => {
  const s = await setup({ ".gitignore": IGNORE, "pkg/.gitignore": "*.log\n", "src/a.go": "package a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    assert.deepEqual(s.byTool("read_file").map((c) => c.args.path).sort(), [".gitignore", "pkg/.gitignore"])
    assert.equal(await readFile(join(tree!.path, "pkg/.gitignore"), "utf8"), "*.log\n")
    const w = (p: string, body: string | Buffer) => mkdir(join(tree!.path, p, ".."), { recursive: true }).then(() => writeFile(join(tree!.path, p), body))
    await w("dist/bundle.js", "x\n")
    await w("node_modules/a/b.js", "x\n")
    await w("coverage/lcov.info", "x\n")
    await w("pkg/__pycache__/m.cpython-312.pyc", Buffer.from([0, 1, 2, 3]))
    await w("pkg/debug.log", "log\n")
    await symlink("/usr", join(tree!.path, ".venv"))
    await w("src/new.go", "package n\n")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(out!.error, "")
    assert.deepEqual((s.byTool("open_merge_request")[0]!.args as { files: unknown[] }).files, [{ path: "src/new.go", content: "package n\n" }])
  } finally {
    await s.cleanup()
  }
})

test("without the .gitignore the same files are refused, so the filter is what lets them pass", async () => {
  const s = await setup({ "src/a.go": "package a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await symlink("/usr", join(tree!.path, ".venv"))
    await mkdir(join(tree!.path, "pkg/__pycache__"), { recursive: true })
    await writeFile(join(tree!.path, "pkg/__pycache__/m.pyc"), Buffer.from([0, 1]))
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.match(out!.error, /not regular files.*\.venv/)
    assert.match(out!.error, /not UTF-8 text.*m\.pyc/)
  } finally {
    await s.cleanup()
  }
})

test("a nested git repository is never entered, and it is refused", async () => {
  const s = await setup({ "src/a.go": "package a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await mkdir(join(tree!.path, "vendor/lib"), { recursive: true })
    await execFileSync("git", ["init", "-q"], { cwd: join(tree!.path, "vendor/lib") })
    await writeFile(join(tree!.path, "vendor/lib/x.go"), "package x\n")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.match(out!.error, /vendor\/lib\/ \(a nested git repository\)/)
    assert.equal(s.byTool("open_merge_request").length, 0)
  } finally {
    await s.cleanup()
  }
})

test("a .gitignore that cannot be read stops the workspace, because the filter would be wrong", async () => {
  const s = await setup({ ".gitignore": IGNORE }, { refuse: { ".gitignore": "the file is not text" } })
  try {
    await assert.rejects(s.ws.prepare("j1", [repo], "g", { resumed: false }), (e: Error) => e instanceof DeliveryRefused && /\.gitignore cannot be read/.test(e.message))
  } finally {
    await s.cleanup()
  }
})

// ---- the grant is renewed (N2a)

test("liveness is read from the renewed grant, and the calls keep the grant they were opened with", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-ws-"))
  try {
    const f = forge({ "a.txt": "a\n" })
    const used: string[] = []
    const tools = Object.assign(
      ((g, c, t, a) => {
        used.push(g)
        return f.tools(g, c, t, a)
      }) as ToolCaller,
      { current: (g: string) => (g === "old" ? "renewed" : g) },
    )
    const ws = new WorkspaceManager({ root: dir, stateDir: join(dir, "state"), tools, grantLive: (g) => g === "renewed" })
    const [tree] = await ws.prepare("j1", [repo], "old", { resumed: false })
    assert.deepEqual(tree!.notes, [], "the old string is expired, and the renewed grant is live")
    await writeFile(join(tree!.path, "b.txt"), "b\n")
    const [out] = await ws.wrapUp("j1", [repo], { ...wrap, grant: "old" })
    assert.equal(out!.error, "")
    assert.ok(used.every((g) => g === "old"), "the harness of the grant sends the renewed token itself")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- a record of another project or ref (N4)

test("a record for another ref is refused on load: the workspace starts again and Claude is told the edits were lost", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const [first] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await s.fetch("j1", "a.txt")
    await writeFile(join(first!.path, "a.txt"), "edited\n")
    const file = join(s.dir, "state", "workspaces", "j1", "api.json")
    const rec = JSON.parse(await readFile(file, "utf8"))
    await writeFile(file, JSON.stringify({ ...rec, ref: "evil-branch" }))
    const fresh = new WorkspaceManager({ root: s.dir, stateDir: join(s.dir, "state"), tools: s.tools, grantLive: () => true })
    const [again] = await fresh.prepare("j1", [repo], "g", { resumed: false })
    assert.match(again!.notes[0]!, /earlier edits to this repository were lost/)
    assert.equal(await readFile(join(again!.path, "a.txt")).then(() => "present", () => "gone"), "gone")
    const read = s.byTool("read_file").length
    const [out] = await fresh.wrapUp("j1", [repo], wrap)
    assert.equal(out!.files, 0)
    assert.equal(s.byTool("read_file").length, read)
  } finally {
    await s.cleanup()
  }
})

test("a record for another project or ref gives no fetch and no delivery", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    await s.ws.prepare("j1", [repo], "g", { resumed: false })
    const other = { ...repo, baseBranch: "develop" }
    assert.match((await s.ws.fetchFile("j1", [other], undefined, "a.txt", "g")).text, /not prepared for this project and ref/)
    const [out] = await s.ws.wrapUp("j1", [other], wrap)
    assert.match(out!.error, /no record of its base for acme\/api at develop/)
    assert.equal(out!.retryable, false)
  } finally {
    await s.cleanup()
  }
})

test("the base is read again at the ref of the job spec", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await s.fetch("j1", "a.txt")
    await writeFile(join(tree!.path, "a.txt"), "edited\n")
    await s.ws.wrapUp("j1", [repo], wrap)
    assert.ok(s.byTool("read_file").every((c) => c.args.ref === "main"))
  } finally {
    await s.cleanup()
  }
})

// ---- writes stay inside the worktree (N6)

test("fetch_file never writes through a symbolic link, in a folder or at the file", async () => {
  const outside = await mkdtemp(join(tmpdir(), "zerocool-outside-"))
  const s = await setup({ "src/a.go": "package a\n", "b.txt": "b\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    await symlink(outside, join(tree!.path, "src"))
    const folder = await s.fetch("j1", "src/a.go")
    assert.equal(folder.ok, false)
    assert.match(folder.text, /src is a symbolic link/)
    await assert.rejects(stat(join(outside, "a.go")), /ENOENT/, "nothing was written outside")
    await writeFile(join(outside, "victim.txt"), "keep\n")
    await symlink(join(outside, "victim.txt"), join(tree!.path, "b.txt"))
    const file = await s.fetch("j1", "b.txt")
    assert.equal(file.ok, false)
    assert.match(file.text, /is a symbolic link/)
    assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "keep\n")
  } finally {
    await s.cleanup()
    await rm(outside, { recursive: true, force: true })
  }
})

test("the first failure of a read stops every runner of the pool", async () => {
  const names = Array.from({ length: 60 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`)
  const files = Object.fromEntries(names.map((n) => [n, "x\n"]))
  const s = await setup(files, { failRead: (p) => p === "f03.txt" })
  try {
    await assert.rejects(s.ws.prepare("j1", [{ ...repo, paths: names }], "g", { resumed: false }), /read_file broke on f03\.txt/)
    assert.ok(s.byTool("read_file").length < 30, `${s.byTool("read_file").length} reads ran after the failure`)
  } finally {
    await s.cleanup()
  }
})

// ---- D1: the agent's index and HEAD do not count

test("a file that Claude staged and a file that Claude committed are both in the change", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=c", "-c", "user.email=c@e", ...args], { cwd: tree!.path })
    await writeFile(join(tree!.path, "staged.txt"), "staged\n")
    git("add", "staged.txt")
    await writeFile(join(tree!.path, "committed.txt"), "committed\n")
    git("add", "committed.txt")
    git("commit", "-q", "-m", "work")
    await writeFile(join(tree!.path, "plain.txt"), "plain\n")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(out!.error, "")
    const files = (s.byTool("open_merge_request")[0]!.args as { files: { path: string }[] }).files
    assert.deepEqual(files.map((f) => f.path).sort(), ["committed.txt", "plain.txt", "staged.txt"])
  } finally {
    await s.cleanup()
  }
})

test("a moved HEAD, a rewritten index and an edited exclude file of the agent do not drop a change", async () => {
  const s = await setup({ ".gitignore": "dist/\n", "a.txt": "a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g", { resumed: false })
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=c", "-c", "user.email=c@e", ...args], { cwd: tree!.path })
    await writeFile(join(tree!.path, "x.txt"), "x\n")
    git("add", "-A")
    git("commit", "-q", "-m", "everything")
    git("reset", "-q", "--hard")
    await writeFile(join(tree!.path, "y.txt"), "y\n")
    await mkdir(join(tree!.path, "dist"), { recursive: true })
    await writeFile(join(tree!.path, "dist/o.js"), "o\n")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(out!.error, "")
    const files = (s.byTool("open_merge_request")[0]!.args as { files: { path: string }[] }).files
    assert.deepEqual(files.map((f) => f.path).sort(), ["x.txt", "y.txt"], "dist is still ignored")
  } finally {
    await s.cleanup()
  }
})

// ---- D2: the grants of a job are released when it ends

test("remove releases the harness of each grant the job used, so no renewal runs after it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-ws-"))
  try {
    const f = forge({ "a.txt": "a\n" })
    const released: string[] = []
    const has = (g: string) => released.includes(g)
    const tools = Object.assign(f.tools, { current: (g: string) => g, release: (g: string) => void released.push(g) })
    const ws = new WorkspaceManager({ root: dir, stateDir: join(dir, "state"), tools, grantLive: () => true })
    await ws.prepare("j1", [repo], "turn-1", { resumed: false })
    await ws.fetchFile("j1", [repo], undefined, "a.txt", "turn-2")
    await ws.wrapUp("j1", [repo], { ...wrap, grant: "turn-3" })
    await ws.prepare("j2", [repo], "other-job", { resumed: false })
    assert.deepEqual(released, [], "nothing is released while the job runs")
    await ws.remove("j1", [repo])
    assert.deepEqual(released.sort(), ["turn-1", "turn-2", "turn-3"])
    await ws.remove("j1", [repo])
    assert.equal(released.length, 3, "a second remove releases nothing twice")
    assert.ok(!has("other-job"), "another job keeps its grant")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- D5: only a grant that is before its exp is retried

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`

test("a grant whose exp has passed is permanent, and a grant inside the margin before exp is retryable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-ws-"))
  try {
    const f = forge({ "a.txt": "a\n" })
    const now = 1_800_000_000_000
    const ws = new WorkspaceManager({ root: dir, stateDir: join(dir, "state"), tools: f.tools, clock: () => now })
    const live = jwt(now / 1000 + 3600)
    const [tree] = await ws.prepare("j1", [repo], live, { resumed: false })
    await writeFile(join(tree!.path, "b.txt"), "b\n")
    const [past] = await ws.wrapUp("j1", [repo], { ...wrap, grant: jwt(now / 1000 - 5) })
    assert.equal(past!.retryable, false)
    const [soon] = await ws.wrapUp("j1", [repo], { ...wrap, grant: jwt(now / 1000 + 10) })
    assert.equal(soon!.retryable, true, "10 seconds before exp is inside the 30 second margin")
    assert.equal(f.byTool("open_merge_request").length, 0)
    const [ok] = await ws.wrapUp("j1", [repo], { ...wrap, grant: live })
    assert.equal(ok!.error, "")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- D7: one method reads the listing and the .gitignore files

test("fetch_file on an unread workspace reads the listing and the .gitignore files, like prepare", async () => {
  const s = await setup({ ".gitignore": "dist/\n", "a.txt": "a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], undefined, { resumed: false })
    assert.equal(s.calls.length, 0)
    const r = await s.fetch("j1", "a.txt")
    assert.equal(r.ok, true)
    assert.deepEqual(s.byTool("read_file").map((c) => c.args.path).sort(), [".gitignore", "a.txt"], "the .gitignore is read before any other file")
    await mkdir(join(tree!.path, "dist"), { recursive: true })
    await writeFile(join(tree!.path, "dist/o.js"), "o\n")
    await writeFile(join(tree!.path, "a.txt"), "edited\n")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(out!.error, "")
    assert.deepEqual((s.byTool("open_merge_request")[0]!.args as { files: unknown[] }).files, [{ path: "a.txt", content: "edited\n" }])
  } finally {
    await s.cleanup()
  }
})

test("fetch_file on an unread workspace stops when a .gitignore cannot be read", async () => {
  const s = await setup({ ".gitignore": "x\n", "a.txt": "a\n" }, { refuse: { ".gitignore": "the file is not text" } })
  try {
    await s.ws.prepare("j1", [repo], undefined, { resumed: false })
    const r = await s.fetch("j1", "a.txt")
    assert.equal(r.ok, false)
    assert.match(r.text, /\.gitignore cannot be read/)
    assert.equal(s.byTool("read_file").some((c) => c.args.path === "a.txt"), false)
  } finally {
    await s.cleanup()
  }
})
