// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { ensureAskpass, runGit, type GitCredential, type GitRunner } from "./git.js"
import type { Deliverable, JobRepository } from "./job.js"

/**
 * The workspace manager (glossary, Workspace manager; zerocool-plugins#106).
 *
 * Layout under the root (`ZEROCOOL_WORKSPACE`, default `/workspace`):
 *
 *   .repos/<connector>/<project>   one bare clone per repository per member, kept warm
 *   jobs/<job_id>/<repo name>      one worktree per repository per job, branch job/<job_id>
 *
 * The connector token is resolved through `GetCredential(<credential name>)`
 * under the base grant, used through `GIT_ASKPASS` for clone, fetch and push
 * only. It is never written to disk and never reaches the Claude process:
 * the turn runner builds the child environment from an allow list (`env.ts`).
 *
 * Eviction is LRU by last use, bounded by `ZEROCOOL_WORKSPACE_CAP_BYTES`.
 * A repository with an open job is never evicted, whatever the cap says.
 */
export interface Worktree {
  repository: string
  path: string
  branch: string
  deliverable: Deliverable
}

export interface WrapUpOutcome {
  repository: string
  branch: string
  deliverable: Deliverable
  /** Commits on the job branch ahead of the base branch, after the wrap-up commit. */
  commits: number
  pushed: boolean
  mergeRequestUrl: string
  error: string
}

/** Opens a merge request on the connector. #108 wires the GitLab MCP tool. */
export interface MergeRequestOpener {
  open(repo: JobRepository, req: { sourceBranch: string; targetBranch: string; title: string; description: string }): Promise<{ url: string }>
}

export interface WorkspaceOptions {
  root: string
  /** State dir for the askpass helper. */
  stateDir: string
  capBytes: number
  /**
   * `GetCredential` under the base grant. A bare string is the token, and the
   * repository's `gitUsername` (or `oauth2`) pairs with it. A full credential
   * carries its own username, which basic auth needs.
   */
  credential: (name: string) => Promise<GitCredential | string>
  mergeRequests?: MergeRequestOpener
  git?: GitRunner
  clock?: () => number
  log?: (line: string) => void
}

interface CloneEntry {
  connectorRef: string
  path: string
  lastUsedAt: number
}

export function cloneCacheKey(repo: JobRepository): string {
  return repo.connectorRef
}

/** `.repos/<connector>/<project>` from `gitlab/acme` + `.../group/project.git`. */
export function clonePath(root: string, repo: JobRepository): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_")
  const project = repo.cloneUrl
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(Boolean)
    .slice(-2)
    .map(safe)
    .join("_")
  return join(root, ".repos", ...repo.connectorRef.split("/").map(safe), project || "repo")
}

export function worktreePath(root: string, jobId: string, repoName: string): string {
  return join(root, "jobs", jobId, repoName)
}

export function jobBranch(jobId: string): string {
  return `job/${jobId}`
}

async function dirSize(path: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(path, e.name)
    if (e.isDirectory()) total += await dirSize(p)
    else if (e.isFile()) total += (await stat(p)).size
  }
  return total
}

export class WorkspaceManager {
  private readonly clones = new Map<string, CloneEntry>()
  private readonly git: GitRunner
  private readonly clock: () => number
  private readonly log: (line: string) => void
  private askpass: string | undefined

  constructor(private readonly opts: WorkspaceOptions) {
    this.git = opts.git ?? runGit
    this.clock = opts.clock ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  private async askpassPath(): Promise<string> {
    if (!this.askpass) this.askpass = await ensureAskpass(this.opts.stateDir)
    return this.askpass
  }

  private async credentialFor(repo: JobRepository): Promise<GitCredential> {
    const resolved = await this.opts.credential(repo.credentialName)
    const credential = typeof resolved === "string" ? { username: repo.gitUsername || "oauth2", token: resolved } : resolved
    if (!credential.token) throw new Error(`GetCredential(${repo.credentialName}) returned an empty secret for ${repo.name}`)
    return { username: repo.gitUsername || credential.username || "oauth2", token: credential.token }
  }

  /** The clone cache entries, for tests and the status line. */
  cached(): CloneEntry[] {
    return [...this.clones.values()]
  }

  /** Clone once, fetch after. Returns the bare clone path. */
  async ensureClone(repo: JobRepository): Promise<string> {
    const key = cloneCacheKey(repo)
    const path = clonePath(this.opts.root, repo)
    const credential = await this.credentialFor(repo)
    const askpassPath = await this.askpassPath()
    let exists = false
    try {
      exists = (await stat(join(path, "HEAD"))).isFile()
    } catch {
      exists = false
    }
    if (!exists) {
      await mkdir(join(path, ".."), { recursive: true })
      this.log(`clone ${repo.name} -> ${path}`)
      await this.git(["clone", "--bare", "--quiet", repo.cloneUrl, path], { cwd: this.opts.root, credential, askpassPath })
    } else {
      this.log(`fetch ${repo.name}`)
      await this.git(["fetch", "--quiet", "--prune", "origin", `+refs/heads/*:refs/heads/*`], { cwd: path, credential, askpassPath })
    }
    this.clones.set(key, { connectorRef: key, path, lastUsedAt: this.clock() })
    return path
  }

  /** One worktree per repository for the job, on `job/<job_id>` from the base branch. */
  async prepare(jobId: string, repos: JobRepository[]): Promise<Worktree[]> {
    const out: Worktree[] = []
    for (const repo of repos) {
      const clone = await this.ensureClone(repo)
      const path = worktreePath(this.opts.root, jobId, repo.name)
      const branch = jobBranch(jobId)
      let present = false
      try {
        present = (await stat(join(path, ".git"))).isFile()
      } catch {
        present = false
      }
      if (!present) {
        await mkdir(join(path, ".."), { recursive: true })
        const branches = await this.git(["branch", "--list", branch], { cwd: clone })
        const args = branches.stdout.trim()
          ? ["worktree", "add", "--quiet", path, branch]
          : ["worktree", "add", "--quiet", "-b", branch, path, repo.baseBranch]
        await this.git(args, { cwd: clone })
      }
      out.push({ repository: repo.name, path, branch, deliverable: repo.deliverable })
    }
    return out
  }

  private async commitsAhead(cwd: string, base: string, branch: string): Promise<number> {
    const r = await this.git(["rev-list", "--count", `${base}..${branch}`], { cwd })
    return Number(r.stdout.trim()) || 0
  }

  private async commitIfDirty(cwd: string, message: string): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"], { cwd })
    if (!status.stdout.trim()) return false
    await this.git(["add", "-A"], { cwd })
    await this.git(["-c", "user.name=zerocool member", "-c", "user.email=member@zeroroot.ai", "commit", "--quiet", "-m", message], { cwd })
    return true
  }

  /**
   * Wrap up one job: commit if dirty, push the job branch under askpass,
   * open the merge request when the deliverable says so, then remove the
   * worktrees. `push` false is the abandon path: push only a PUSH_BRANCH
   * deliverable with commits so work is not lost.
   */
  async wrapUp(jobId: string, repos: JobRepository[], opts: { push: boolean; title: string; description: string }): Promise<WrapUpOutcome[]> {
    const out: WrapUpOutcome[] = []
    for (const repo of repos) {
      const path = worktreePath(this.opts.root, jobId, repo.name)
      const branch = jobBranch(jobId)
      const outcome: WrapUpOutcome = { repository: repo.name, branch, deliverable: repo.deliverable, commits: 0, pushed: false, mergeRequestUrl: "", error: "" }
      try {
        await this.commitIfDirty(path, `job ${jobId}: wrap-up`)
        outcome.commits = await this.commitsAhead(path, repo.baseBranch, branch)
        const wantsPush = repo.deliverable !== "NONE" && (opts.push || (repo.deliverable === "PUSH_BRANCH" && outcome.commits > 0))
        if (wantsPush && outcome.commits > 0) {
          const credential = await this.credentialFor(repo)
          const askpassPath = await this.askpassPath()
          await this.git(["push", "--quiet", "--force-with-lease", "origin", `${branch}:${branch}`], { cwd: path, credential, askpassPath })
          outcome.pushed = true
          if (!opts.push) outcome.error = "abandoned: branch pushed so the commits are not lost, no merge request opened"
        }
        if (opts.push && repo.deliverable === "MERGE_REQUEST" && outcome.pushed) {
          if (!this.opts.mergeRequests) throw new Error("no merge request opener is configured")
          const mr = await this.opts.mergeRequests.open(repo, { sourceBranch: branch, targetBranch: repo.baseBranch, title: opts.title, description: opts.description })
          outcome.mergeRequestUrl = mr.url
        }
      } catch (e) {
        outcome.error = (e as Error).message
      }
      out.push(outcome)
    }
    await this.remove(jobId, repos)
    return out
  }

  /** Remove the job's worktrees. Nothing else deletes a worktree (glossary, Close). */
  async remove(jobId: string, repos: JobRepository[]): Promise<void> {
    for (const repo of repos) {
      const path = worktreePath(this.opts.root, jobId, repo.name)
      const clone = clonePath(this.opts.root, repo)
      try {
        await this.git(["worktree", "remove", "--force", path], { cwd: clone })
      } catch (e) {
        this.log(`worktree remove ${path}: ${(e as Error).message}`)
        await rm(path, { recursive: true, force: true })
      }
      try {
        await this.git(["worktree", "prune"], { cwd: clone })
      } catch {
        // the clone is gone too
      }
    }
    await rm(join(this.opts.root, "jobs", jobId), { recursive: true, force: true })
  }

  /** Evict least recently used clones until under the cap. Skips `inUse` connector refs. */
  async evict(inUse: Set<string>): Promise<string[]> {
    const sizes = new Map<string, number>()
    let total = 0
    for (const c of this.clones.values()) {
      const s = await dirSize(c.path)
      sizes.set(c.connectorRef, s)
      total += s
    }
    const evicted: string[] = []
    const candidates = [...this.clones.values()].filter((c) => !inUse.has(c.connectorRef)).sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    for (const c of candidates) {
      if (total <= this.opts.capBytes) break
      this.log(`evict ${c.connectorRef} (${sizes.get(c.connectorRef)} bytes, last used ${c.lastUsedAt})`)
      await rm(c.path, { recursive: true, force: true })
      this.clones.delete(c.connectorRef)
      total -= sizes.get(c.connectorRef) ?? 0
      evicted.push(c.connectorRef)
    }
    return evicted
  }
}
