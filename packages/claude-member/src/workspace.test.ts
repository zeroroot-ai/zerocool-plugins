// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ToolCallError, type ToolCaller } from "./connector-tools.js"
import type { JobRepository } from "./job.js"
import { assertGitArgument, DeliveryRefused, jobBranch, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, WorkspaceManager, worktreePath } from "./workspace.js"

/**
 * The tests use a fake connector that answers `list_tree`, `read_file` and
 * `open_merge_request` in the documented shapes (connectors v0.7.0). The git
 * commands are real, run on a local directory. There is no remote and no token.
 */
interface FakeFile {
  content: string
  mode?: string
}

interface Call {
  grant: string
  connectorRef: string
  tool: string
  args: Record<string, unknown>
}

function forge(files: Record<string, FakeFile | string>, over: { pageSize?: number; truncated?: boolean; extraEntries?: Record<string, unknown>[]; unreadable?: string[] } = {}) {
  const calls: Call[] = []
  const paths = Object.keys(files).sort()
  const entry = (p: string) => {
    const f = files[p]!
    const c = typeof f === "string" ? f : f.content
    return { path: p, type: "file", sha: "abc", size: Buffer.byteLength(c), mode: typeof f === "string" ? "100644" : (f.mode ?? "100644") }
  }
  const all = [...paths.map(entry), ...(over.extraEntries ?? [])]
  const tools: ToolCaller = async (grant, connectorRef, tool, args) => {
    calls.push({ grant, connectorRef, tool, args })
    if (tool === "list_tree") {
      const size = over.pageSize ?? 1000
      const start = args.cursor ? Number(args.cursor) : 0
      const page = all.slice(start, start + size)
      const next = start + size < all.length ? String(start + size) : ""
      return { project: args.project, ref: args.ref, path: "", next_cursor: next, truncated: over.truncated ?? false, reason: over.truncated ? "the host cut the list at 100000 entries" : "", entries: page }
    }
    if (tool === "read_file") {
      const p = String(args.path)
      if (over.unreadable?.includes(p)) throw new ToolCallError("read_file", "the file is not UTF-8 text")
      const f = files[p]
      if (f === undefined) return { found: false }
      return { found: true, content: typeof f === "string" ? f : f.content, path: p }
    }
    if (tool === "open_merge_request") return { merge_request: "acme/api#12", url: "https://git.example/acme/api/pull/12", source_branch: args.branch, existing: false }
    throw new Error(`unexpected tool ${tool}`)
  }
  return { tools, calls, byTool: (t: string) => calls.filter((c) => c.tool === t) }
}

const repo: JobRepository = { name: "api", connectorRef: "connector/acme", project: "acme/api", baseBranch: "main", deliverable: "MERGE_REQUEST" }
const wrap = { push: true, title: "job j1: fix the route", description: "the goal", grant: "wrap-grant" }

async function setup(files: Record<string, FakeFile | string>, over: Parameters<typeof forge>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-ws-"))
  const f = forge(files, over)
  const ws = new WorkspaceManager({ root: dir, tools: f.tools })
  return { dir, ws, ...f, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })

test("prepare reads the tree and the files through the connector tools under the turn grant, and commits a local base", async () => {
  const s = await setup({ "README.md": "hello\n", "src/app.go": "package app\n", "src/deep/x.txt": "x\n" }, { pageSize: 2 })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "turn-grant")
    assert.equal(tree!.path, worktreePath(s.dir, "j1", "api"))
    assert.equal(tree!.branch, jobBranch("j1"))
    assert.equal(await readFile(join(tree!.path, "src/deep/x.txt"), "utf8"), "x\n")
    assert.equal(s.byTool("list_tree").length, 2, "the cursor pages the tree")
    assert.deepEqual(s.byTool("list_tree")[0]!.args, { project: "acme/api", ref: "main" })
    assert.equal(s.byTool("list_tree")[1]!.args.cursor, "2")
    assert.equal(s.byTool("read_file").length, 3)
    assert.ok(s.calls.every((c) => c.grant === "turn-grant" && c.connectorRef === "connector/acme"))
    assert.equal(git(tree!.path, "remote").trim(), "", "no remote")
    assert.equal(git(tree!.path, "branch", "--show-current").trim(), "job/j1")
    assert.equal(git(tree!.path, "status", "--porcelain").trim(), "", "the base is committed")
    assert.equal(git(tree!.path, "rev-list", "--count", "refs/zerocool/base").trim(), "1")
  } finally {
    await s.cleanup()
  }
})

test("a resumed job keeps its tree and reads nothing again", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g1")
    await writeFile(join(tree!.path, "work.txt"), "kept\n")
    await s.ws.prepare("j1", [repo], "g2")
    assert.equal(s.byTool("list_tree").length, 1)
    assert.equal(await readFile(join(tree!.path, "work.txt"), "utf8"), "kept\n")
  } finally {
    await s.cleanup()
  }
})

test("the diff against the base becomes one open_merge_request with the branch and the files", async () => {
  const s = await setup({ "README.md": "hello\n", "src/old.go": "old\n", "src/keep.go": "keep\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "turn-grant")
    await writeFile(join(tree!.path, "README.md"), "hello world\n")
    await writeFile(join(tree!.path, "src/new.go"), "package new\n")
    await unlink(join(tree!.path, "src/old.go"))
    // Claude commits some of the work. The diff still counts from the base.
    git(tree!.path, "add", "-A")
    git(tree!.path, "-c", "user.name=c", "-c", "user.email=c@e", "commit", "-q", "-m", "work")
    await writeFile(join(tree!.path, "later.txt"), "uncommitted\n")

    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    const opened = s.byTool("open_merge_request")
    assert.equal(opened.length, 1, "one call")
    assert.equal(opened[0]!.grant, "wrap-grant")
    assert.equal(opened[0]!.connectorRef, "connector/acme")
    const a = opened[0]!.args as { files: { path: string; content?: string; delete?: boolean }[] }
    assert.deepEqual({ ...opened[0]!.args, files: undefined }, { project: "acme/api", base_branch: "main", branch: "job/j1", title: "job j1: fix the route", description: "the goal", files: undefined })
    assert.deepEqual(
      [...a.files].sort((x, y) => (x.path < y.path ? -1 : 1)),
      [
        { path: "README.md", content: "hello world\n" },
        { path: "later.txt", content: "uncommitted\n" },
        { path: "src/new.go", content: "package new\n" },
        { path: "src/old.go", delete: true },
      ],
    )
    assert.equal(out!.mergeRequest, "acme/api#12")
    assert.equal(out!.mergeRequestUrl, "https://git.example/acme/api/pull/12")
    assert.equal(out!.error, "")
    assert.equal(out!.files, 4)
    await assert.rejects(stat(join(s.dir, "jobs", "j1")), /ENOENT/, "the job directory is removed")
  } finally {
    await s.cleanup()
  }
})

test("a job with no change opens nothing", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    await s.ws.prepare("j1", [repo], "g")
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(s.byTool("open_merge_request").length, 0)
    assert.equal(out!.files, 0)
    assert.equal(out!.mergeRequestUrl, "")
  } finally {
    await s.cleanup()
  }
})

test("an abandoned job opens nothing and says so", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g")
    await writeFile(join(tree!.path, "b.txt"), "b\n")
    const [out] = await s.ws.wrapUp("j1", [repo], { ...wrap, push: false })
    assert.equal(s.byTool("open_merge_request").length, 0)
    assert.match(out!.error, /abandoned: no merge request opened/)
  } finally {
    await s.cleanup()
  }
})

test("PUSH_BRANCH is refused with a clear result, because no tool pushes a branch", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const r = { ...repo, deliverable: "PUSH_BRANCH" as const }
    const [tree] = await s.ws.prepare("j1", [r], "g")
    await writeFile(join(tree!.path, "b.txt"), "b\n")
    const [out] = await s.ws.wrapUp("j1", [r], wrap)
    assert.equal(s.byTool("open_merge_request").length, 0)
    assert.match(out!.error, /PUSH_BRANCH is not supported/)
  } finally {
    await s.cleanup()
  }
})

async function refuses(change: (dir: string) => Promise<void>, expected: RegExp): Promise<void> {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g")
    await change(tree!.path)
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(s.byTool("open_merge_request").length, 0, "nothing is delivered over a limit")
    assert.match(out!.error, /The merge request was not opened\./)
    assert.match(out!.error, expected)
    assert.equal(out!.mergeRequestUrl, "")
  } finally {
    await s.cleanup()
  }
}

test("more than 100 files is refused with the limit in the result", async () => {
  await refuses(async (dir) => {
    for (let i = 0; i <= MAX_FILES; i++) await writeFile(join(dir, `f${i}.txt`), "x\n")
  }, /101 files\. The limit of open_merge_request is 100/)
})

test("a file over 1 MiB is refused and named", async () => {
  await refuses(async (dir) => writeFile(join(dir, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1)), /big\.txt \(1048577 bytes\)/)
})

test("files over 8 MiB in all are refused", async () => {
  await refuses(async (dir) => {
    for (let i = 0; i < 9; i++) await writeFile(join(dir, `m${i}.txt`), "x".repeat(MAX_FILE_BYTES))
  }, new RegExp(`add up to ${9 * MAX_FILE_BYTES} bytes\\. The limit for all files is ${MAX_TOTAL_BYTES}`))
})

test("a binary file is refused, because the tool takes text only", async () => {
  await refuses(async (dir) => writeFile(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0, 1, 2])), /not UTF-8 text.*logo\.png/)
  await refuses(async (dir) => writeFile(join(dir, "bad.txt"), Buffer.from([0xff, 0xfe, 0x41])), /not UTF-8 text.*bad\.txt/)
})

test("a symbolic link in the change is refused", async () => {
  await refuses(async (dir) => symlink("a.txt", join(dir, "link")), /link \(mode 120000\)/)
})

test("a truncated tree is refused, nothing is read, and no workspace is left", async () => {
  const s = await setup({ "a.txt": "a\n" }, { truncated: true })
  try {
    await assert.rejects(s.ws.prepare("j1", [repo], "g"), (e: Error) => e instanceof DeliveryRefused && /cut the tree of acme\/api at main \(the host cut the list/.test(e.message) && /partial tree is never delivered/.test(e.message))
    assert.equal(s.byTool("read_file").length, 0)
    await assert.rejects(stat(worktreePath(s.dir, "j1", "api")), /ENOENT/)
    await assert.rejects(stat(`${worktreePath(s.dir, "j1", "api")}.partial`), /ENOENT/)
    assert.equal(s.byTool("open_merge_request").length, 0)
  } finally {
    await s.cleanup()
  }
})

test("folders, symbolic links, submodules, unsafe paths and unreadable files stay out of the base", async () => {
  const s = await setup(
    { "ok.txt": "ok\n", "bin.dat": "binary" },
    {
      unreadable: ["bin.dat"],
      extraEntries: [
        { path: "dir", type: "dir", mode: "040000" },
        { path: "ln", type: "symlink", mode: "120000" },
        { path: "mod", type: "submodule", mode: "160000" },
        { path: "../escape", type: "file", mode: "100644", size: 1 },
        { path: "x/.git/config", type: "file", mode: "100644", size: 1 },
      ],
    },
  )
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g")
    assert.equal(git(tree!.path, "ls-files").trim(), "ok.txt")
    assert.deepEqual(
      s.byTool("read_file").map((c) => c.args.path).sort(),
      ["bin.dat", "ok.txt"],
    )
  } finally {
    await s.cleanup()
  }
})

test("an executable file keeps its mode, and an edit of it is a content change", async () => {
  const s = await setup({ "run.sh": { content: "#!/bin/sh\n", mode: "100755" } })
  try {
    const [tree] = await s.ws.prepare("j1", [repo], "g")
    assert.ok(((await stat(join(tree!.path, "run.sh"))).mode & 0o111) !== 0)
    await writeFile(join(tree!.path, "run.sh"), "#!/bin/sh\necho hi\n")
    await chmod(join(tree!.path, "run.sh"), 0o755)
    const [out] = await s.ws.wrapUp("j1", [repo], wrap)
    assert.equal(out!.error, "")
    assert.deepEqual((s.byTool("open_merge_request")[0]!.args as { files: unknown[] }).files, [{ path: "run.sh", content: "#!/bin/sh\necho hi\n" }])
  } finally {
    await s.cleanup()
  }
})

test("a refusal of the tool itself comes back as the error of the outcome", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    const failing = new WorkspaceManager({
      root: s.dir,
      tools: async (g, c, t, a) => {
        if (t === "open_merge_request") throw new ToolCallError(t, "the branch holds a foreign commit")
        return s.tools(g, c, t, a)
      },
    })
    const [tree] = await failing.prepare("j1", [repo], "g")
    await writeFile(join(tree!.path, "b.txt"), "b\n")
    const [out] = await failing.wrapUp("j1", [repo], wrap)
    assert.match(out!.error, /open_merge_request: the branch holds a foreign commit/)
    assert.equal(out!.mergeRequestUrl, "")
  } finally {
    await s.cleanup()
  }
})

test("a job id, repository name or base branch git could read as an option or a path escape is refused", async () => {
  const s = await setup({ "a.txt": "a\n" })
  try {
    await assert.rejects(s.ws.prepare("--upload-pack=touch /tmp/pwned", [repo], "g"), /job id .* starts with a dash/)
    await assert.rejects(s.ws.prepare("../escape", [repo], "g"), /job id .* contains \.\./)
    await assert.rejects(s.ws.prepare("j1", [{ ...repo, name: "-x" }], "g"), /repository name .* starts with a dash/)
    await assert.rejects(s.ws.prepare("j1", [{ ...repo, name: "a/b" }], "g"), /repository name .* contains a slash/)
    await assert.rejects(s.ws.prepare("j1", [{ ...repo, baseBranch: "--upload-pack=x" }], "g"), /base branch .* starts with a dash/)
    await assert.rejects(s.ws.remove("../escape", [repo]), /job id .* contains \.\./)
    assert.equal(assertGitArgument("base branch", "release/2026.09"), "release/2026.09")
    assert.equal(assertGitArgument("job id", "job_1.a-b", { path: true }), "job_1.a-b")
    assert.equal(s.calls.length, 0, "a refused argument calls no tool")
  } finally {
    await s.cleanup()
    await mkdir(tmpdir(), { recursive: true })
  }
})
