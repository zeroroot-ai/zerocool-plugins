// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runGit, type GitRunner } from "./git.js"
import type { JobRepository } from "./job.js"
import { clonePath, jobBranch, WorkspaceManager, worktreePath } from "./workspace.js"

/**
 * The tests run against a real local bare repository, so `git worktree add`,
 * `push` and `worktree remove` are the real commands, not a stub. The token is
 * never needed for a file:// remote, but every git call still goes through the
 * same credential path, so the environment assertions hold.
 */
async function origin(dir: string): Promise<string> {
  const work = join(dir, "seed")
  const bare = join(dir, "origin.git")
  await mkdir(work, { recursive: true })
  await runGit(["init", "--quiet", "--initial-branch=main", work], { cwd: dir })
  await writeFile(join(work, "README.md"), "seed\n")
  await runGit(["add", "README.md"], { cwd: work })
  await runGit(["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "seed"], { cwd: work })
  await runGit(["clone", "--bare", "--quiet", work, bare], { cwd: dir })
  return bare
}

function repository(cloneUrl: string, over: Partial<JobRepository> = {}): JobRepository {
  return { name: "api", connectorRef: "gitlab/acme", cloneUrl, baseBranch: "main", deliverable: "MERGE_REQUEST", credentialName: "gitlab-token", ...over }
}

async function fixture(): Promise<{ dir: string; root: string; repo: JobRepository; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-ws-"))
  const root = join(dir, "workspace")
  await mkdir(root, { recursive: true })
  return { dir, root, repo: repository(await origin(dir)), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("the clone cache holds one clone per repository, and a second job reuses it", async () => {
  const f = await fixture()
  try {
    const calls: string[][] = []
    const git: GitRunner = (args, opts) => {
      calls.push(args)
      return runGit(args, opts)
    }
    const ws = new WorkspaceManager({ root: f.root, stateDir: join(f.dir, "state"), capBytes: 1 << 30, credential: async () => "glpat-secret", git })
    const first = await ws.prepare("job-1", [f.repo])
    const second = await ws.prepare("job-2", [f.repo])
    assert.equal(calls.filter((c) => c[0] === "clone").length, 1, "the second job fetches, it does not clone again")
    assert.ok(calls.some((c) => c[0] === "fetch"))

    assert.equal(first[0]!.path, worktreePath(f.root, "job-1", "api"))
    assert.equal(second[0]!.path, worktreePath(f.root, "job-2", "api"))
    assert.equal(first[0]!.branch, jobBranch("job-1"))
    assert.notEqual(first[0]!.branch, second[0]!.branch, "unrelated jobs never share a worktree or a branch")
    assert.ok((await stat(join(first[0]!.path, "README.md"))).isFile())
    assert.ok((await stat(join(second[0]!.path, "README.md"))).isFile())
    assert.equal(clonePath(f.root, f.repo).startsWith(join(f.root, ".repos", "gitlab", "acme")), true)
  } finally {
    await f.cleanup()
  }
})

test("wrap-up commits, pushes the job branch and removes the worktree", async () => {
  const f = await fixture()
  try {
    const opened: { sourceBranch: string; targetBranch: string }[] = []
    const ws = new WorkspaceManager({
      root: f.root,
      stateDir: join(f.dir, "state"),
      capBytes: 1 << 30,
      credential: async () => "glpat-secret",
      mergeRequests: { open: async (_r, req) => (opened.push(req), { url: "https://git.example/acme/api/-/merge_requests/1" }) },
    })
    const [wt] = await ws.prepare("job-1", [f.repo])
    await writeFile(join(wt!.path, "fix.txt"), "the fix\n")

    const outcomes = await ws.wrapUp("job-1", [f.repo], { push: true, title: "job job-1", description: "why" })
    assert.equal(outcomes[0]!.error, "")
    assert.equal(outcomes[0]!.pushed, true)
    assert.equal(outcomes[0]!.commits, 1)
    assert.equal(outcomes[0]!.mergeRequestUrl, "https://git.example/acme/api/-/merge_requests/1")
    assert.deepEqual(opened, [{ sourceBranch: "job/job-1", targetBranch: "main", title: "job job-1", description: "why" }])

    const branches = await runGit(["branch", "--list", "job/job-1"], { cwd: f.repo.cloneUrl })
    assert.match(branches.stdout, /job\/job-1/, "the branch reached the origin")
    await assert.rejects(stat(wt!.path), "the worktree is gone")
  } finally {
    await f.cleanup()
  }
})

test("abandon pushes a PUSH_BRANCH deliverable so the work is not lost, and opens no merge request", async () => {
  const f = await fixture()
  try {
    const repo = repository(f.repo.cloneUrl, { deliverable: "PUSH_BRANCH" })
    const ws = new WorkspaceManager({ root: f.root, stateDir: join(f.dir, "state"), capBytes: 1 << 30, credential: async () => "glpat-secret" })
    const [wt] = await ws.prepare("job-3", [repo])
    await writeFile(join(wt!.path, "half.txt"), "half done\n")
    const outcomes = await ws.wrapUp("job-3", [repo], { push: false, title: "t", description: "d" })
    assert.equal(outcomes[0]!.pushed, true)
    assert.equal(outcomes[0]!.mergeRequestUrl, "")
    assert.match(outcomes[0]!.error, /abandoned: branch pushed/)
  } finally {
    await f.cleanup()
  }
})

test("a NONE deliverable pushes nothing at all", async () => {
  const f = await fixture()
  try {
    const repo = repository(f.repo.cloneUrl, { deliverable: "NONE" })
    const ws = new WorkspaceManager({ root: f.root, stateDir: join(f.dir, "state"), capBytes: 1 << 30, credential: async () => "glpat-secret" })
    const [wt] = await ws.prepare("job-4", [repo])
    await writeFile(join(wt!.path, "note.txt"), "read only\n")
    const outcomes = await ws.wrapUp("job-4", [repo], { push: true, title: "t", description: "d" })
    assert.equal(outcomes[0]!.pushed, false)
    const branches = await runGit(["branch", "--list", "job/job-4"], { cwd: repo.cloneUrl })
    assert.equal(branches.stdout.trim(), "")
  } finally {
    await f.cleanup()
  }
})

test("eviction never removes a repository an open job holds", async () => {
  const f = await fixture()
  try {
    const ws = new WorkspaceManager({ root: f.root, stateDir: join(f.dir, "state"), capBytes: 0, credential: async () => "glpat-secret" })
    await ws.prepare("job-1", [f.repo])
    assert.deepEqual(await ws.evict(new Set(["gitlab/acme"])), [], "a cap of zero still keeps a repository in use")
    assert.equal(ws.cached().length, 1)
    assert.deepEqual(await ws.evict(new Set()), ["gitlab/acme"], "with no open job the cap applies")
    assert.equal(ws.cached().length, 0)
    await assert.rejects(stat(clonePath(f.root, f.repo)))
  } finally {
    await f.cleanup()
  }
})

test("eviction under the cap removes nothing", async () => {
  const f = await fixture()
  try {
    const ws = new WorkspaceManager({ root: f.root, stateDir: join(f.dir, "state"), capBytes: 1 << 30, credential: async () => "glpat-secret" })
    await ws.prepare("job-1", [f.repo])
    assert.deepEqual(await ws.evict(new Set()), [])
  } finally {
    await f.cleanup()
  }
})

test("the connector token reaches git through askpass and never lands on argv or on disk", async () => {
  const f = await fixture()
  try {
    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    const git: GitRunner = async (args, opts) => {
      const { gitEnv } = await import("./git.js")
      seen.push({ args, env: gitEnv(opts) })
      return runGit(args, opts)
    }
    const ws = new WorkspaceManager({ root: f.root, stateDir: join(f.dir, "state"), capBytes: 1 << 30, credential: async () => "glpat-secret", git })
    await ws.prepare("job-1", [f.repo])
    const clone = seen.find((c) => c.args[0] === "clone")!
    assert.ok(!clone.args.some((a) => a.includes("glpat-secret")), "no token on argv: /proc/<pid>/cmdline is readable")
    assert.equal(clone.env.ZEROCOOL_GIT_TOKEN, "glpat-secret", "the token lives in the git child's environment only")
    assert.ok(String(clone.env.GIT_ASKPASS).endsWith("git-askpass.sh"))
    const worktree = seen.find((c) => c.args[0] === "worktree")!
    assert.equal(worktree.env.ZEROCOOL_GIT_TOKEN, undefined, "a local git command gets no credential at all")
  } finally {
    await f.cleanup()
  }
})

test("an empty credential fails the job instead of cloning anonymously", async () => {
  const f = await fixture()
  try {
    const ws = new WorkspaceManager({ root: f.root, stateDir: join(f.dir, "state"), capBytes: 1 << 30, credential: async () => "" })
    await assert.rejects(ws.prepare("job-1", [f.repo]), /returned an empty secret/)
  } finally {
    await f.cleanup()
  }
})
