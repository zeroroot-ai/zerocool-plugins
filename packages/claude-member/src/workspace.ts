// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { promisify } from "node:util"
import { decodeGrantClaims } from "@zeroroot-ai/sdk"
import { ToolCallError, type GrantedToolCaller, type ToolCaller } from "./connector-tools.js"
import type { Deliverable, JobRepository } from "./job.js"

const execFileAsync = promisify(execFile)

/**
 * The workspace manager (glossary, Workspace manager; zerocool-plugins#106).
 *
 * The member holds no forge credential and runs no git transport. An untrusted
 * sandboxed agent holds no tenant secret, and the daemon refuses to give it
 * one. The workspace reads and delivers through the governed connector tools.
 * The workspace is SPARSE and read on demand:
 *
 *   prepare     `list_tree` (all pages) gives the listing of the base branch.
 *               The listing is kept in a record the driver owns, never in a git
 *               ref the agent could move. `read_file` writes only the files the
 *               job names.
 *   fetch_file  the member tool of Claude. It calls `read_file` under the
 *               grant of the turn, writes the file and records its blob sha and
 *               content hash as the base of that path.
 *   wrap-up     the driver compares the files on disk with the record. A change
 *               is an edit or a delete of a fetched path, or an add of a path
 *               the listing does not hold. It reads each base path again, and
 *               refuses when the base branch moved. It then opens ONE merge
 *               request per repository with `open_merge_request`, on `job/<id>`.
 *
 * Every call runs under a live grant of a TURN of the job, never the member
 * base grant, so the daemon binds the merge request to the job. The delivery
 * does not use git: the walk and the hashes decide. `git init` only gives the
 * agent a repository to read diffs in.
 *
 * Layout under the root (`ZEROCOOL_WORKSPACE`, default `/workspace`):
 *
 *   jobs/<job_id>/<repo name>   the sparse work tree
 *
 * The record lives in memory and in `<stateDir>/workspaces/<job_id>/`. A shell
 * of the same user could edit that file, but the connector checks the base
 * again at wrap-up, so a forged record cannot deliver a stale base.
 */
export interface Worktree {
  repository: string
  path: string
  branch: string
  deliverable: Deliverable
  /** Facts the turn prompt must state: a tree read later, or a workspace lost. */
  notes: string[]
}

export interface WrapUpOutcome {
  repository: string
  branch: string
  deliverable: Deliverable
  /** Files in the change: the files of the `open_merge_request` call. */
  files: number
  /** The `merge_request` key of the tool result, when a merge request was opened. */
  mergeRequest: string
  mergeRequestUrl: string
  /** Set when the deliverable was not performed. The text names the reason. */
  error: string
  /** True when `error` is a failure of the job. An abandoned job is not one. */
  failed: boolean
  /** True when a later try can succeed. The workspace stays. A permanent refusal sets false. */
  retryable: boolean
}

/** The limits of `open_merge_request` (connectors README, Git host contract). */
export const MAX_FILES = 100
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024
export const MAX_TITLE_BYTES = 256
export const MAX_DESCRIPTION_BYTES = 20_000

/** The most files that git lists as not ignored. A tree of `node_modules` is not a change. */
const MAX_WALK_FILES = 20_000

/** How many `read_file` calls run at once. */
const READ_CONCURRENCY = 8

/** A grant must live this much longer than the call that uses it, ms. */
const GRANT_MARGIN_MS = 30_000

/**
 * A delivery the workspace refuses on purpose: a truncated tree, a change over
 * a limit, a path the tool cannot take, a base that moved. It is permanent.
 * The message is the result of the job and says what to change.
 */
export class DeliveryRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeliveryRefused"
  }
}

export interface WorkspaceOptions {
  root: string
  /** The driver's state dir. The record of each workspace is kept there. */
  stateDir: string
  /** Calls a connector tool under the grant it is given. */
  tools: ToolCaller
  /** Whether a turn grant is still good. Default: the `exp` claim, with a margin. */
  grantLive?: (grant: string) => boolean
  clock?: () => number
  log?: (line: string) => void
}

export function worktreePath(root: string, jobId: string, repoName: string): string {
  return join(root, "jobs", jobId, repoName)
}

export function jobBranch(jobId: string): string {
  return `job/${jobId}`
}

/**
 * Refuse a value that git could read as an option or that could leave the
 * workspace root. Job ids, repository names and base branches come from the
 * bank over the wire; they are positional git arguments and path elements
 * here (CodeQL js/second-order-command-line-injection, zerocool-plugins#13).
 * A ref name follows `git check-ref-format`: no leading `-`, no `..`, no
 * control or space characters, no `@{`, no `\\`, no `.lock` suffix.
 */
export function assertGitArgument(what: string, value: string, opts: { path?: boolean } = {}): string {
  const reject = (why: string): never => {
    throw new Error(`${what} ${JSON.stringify(value)} is not usable: ${why}`)
  }
  if (value === "") reject("it is empty")
  if (value.startsWith("-")) reject("it starts with a dash, which git reads as an option")
  if (value.includes("..")) reject("it contains ..")
  if (value.endsWith(".lock") || value.endsWith("/") || value.endsWith(".")) reject("it ends with .lock, a slash or a dot")
  if (value.includes("@{") || value.includes("\\")) reject("it contains @{ or a backslash")
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (code < 0x21 || code === 0x7f) reject("it contains a control or space character")
    if (ch === "~" || ch === "^" || ch === ":" || ch === "?" || ch === "*" || ch === "[") reject(`it contains ${ch}`)
    if (opts.path && ch === "/") reject("it contains a slash, and it names one directory")
  }
  if (opts.path && (value === "." || value === "..")) reject("it names the current or parent directory")
  return value
}

/** The job id and every repository name are one path element each. */
function assertNames(jobId: string, repos: { name: string }[]): void {
  assertGitArgument("job id", jobId, { path: true })
  for (const repo of repos) assertGitArgument("repository name", repo.name, { path: true })
}

/** Local git only, to make the repository. No credential, no hook, no fsmonitor. */
async function git(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extraEnv,
  }
  const full = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.excludesFile=/dev/null", ...args]
  try {
    const { stdout } = await execFileAsync("git", full, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new Error(`git ${args[0]} failed: ${(err.stderr ?? err.message).trim().slice(0, 500)}`)
  }
}

interface TreeEntry {
  path: string
  /** `file`, `dir`, `symlink` or `submodule`. */
  type: string
  sha?: string
  size?: number
  mode?: string
}

/** The documented output of the connector tool `list_tree`. */
interface TreePage {
  entries?: TreeEntry[]
  next_cursor?: string
  truncated?: boolean
  reason?: string
}

/** The documented output of the connector tool `read_file`. */
interface ReadFileResult {
  found?: boolean
  content?: string
  sha?: string
}

/** The base of one path the agent fetched. */
interface Fetched {
  /** The blob sha `read_file` gave, equal to the listing sha. */
  sha: string
  /** The SHA-256 of the bytes written to disk. */
  hash: string
  /** The mode of the listing, `100644` or `100755`. */
  mode: string
}

/** The record of one repository of one job. */
interface RepoRecord {
  project: string
  ref: string
  /** `null` until the listing was read, which needs a turn grant. */
  listing: Record<string, TreeEntry> | null
  fetched: Record<string, Fetched>
}

/** A path from the connector is one relative path with no `..`, no `.git` folder and no empty folder name. */
function safeTreePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git")
}

/** The connector texts for a file `read_file` will not give: not text, too large, or an encoding of none. */
export function isRefusedFile(e: unknown): boolean {
  return e instanceof ToolCallError && /the file is not text|the file is larger than|encoding\b[^\n]{0,20}\bnone\b/i.test(e.message)
}

/** A failure that a later try can mend: a network failure, UNAVAILABLE, or "call the tool again". */
function isTransient(e: unknown): boolean {
  return e instanceof ToolCallError && e.transient
}

async function inPool<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  const runner = async (): Promise<void> => {
    // The first failure stops every runner: no new call starts after it.
    while (next < items.length && !failed) {
      const item = items[next++]!
      try {
        await work(item)
      } catch (e) {
        failed = true
        throw e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, runner))
}

interface FileChange {
  path: string
  content?: string
  delete?: true
}

/** The text of a file, or `undefined` when it is binary or not UTF-8. A BOM stays in the text. */
function textOf(buf: Buffer): string | undefined {
  if (buf.includes(0)) return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf)
  } catch {
    return undefined
  }
}

const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex")

function listed(paths: string[]): string {
  return paths.slice(0, 5).join(", ") + (paths.length > 5 ? `, and ${paths.length - 5} more` : "")
}

/** `s` cut to at most `max` bytes of UTF-8, on a character boundary. */
export function cutBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s
  let out = ""
  let used = 0
  for (const ch of s) {
    const n = Buffer.byteLength(ch)
    if (used + n > max) break
    out += ch
    used += n
  }
  return out
}

/** Every folder above `path`, nearest last. */
function ancestors(path: string): string[] {
  const parts = path.split("/")
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))
}

export class WorkspaceManager {
  private readonly log: (line: string) => void
  private readonly clock: () => number
  private readonly records = new Map<string, RepoRecord>()
  /** The grants each job used. `remove` releases their harnesses, which stops the renewal. */
  private readonly grantsOf = new Map<string, Set<string>>()
  private readonly releaseGrant: (grant: string) => void
  private readonly grantLive: (grant: string) => boolean
  /** The grant in force for a turn grant. The harness renews its grant, so this is the live one. */
  private readonly currentOf: (grant: string) => string

  constructor(private readonly opts: WorkspaceOptions) {
    this.log = opts.log ?? (() => {})
    this.clock = opts.clock ?? Date.now
    this.grantLive = opts.grantLive ?? ((grant) => this.liveByClaims(grant))
    const granted = opts.tools as Partial<GrantedToolCaller>
    this.currentOf = granted.current ? (grant) => granted.current!(grant) : (grant) => grant
    this.releaseGrant = granted.release ? (grant) => granted.release!(grant) : () => {}
  }

  /** Note that the job uses `grant`, so `remove` can release it. */
  private track(jobId: string, grant: string | undefined): void {
    if (!grant) return
    const set = this.grantsOf.get(jobId) ?? new Set<string>()
    set.add(grant)
    this.grantsOf.set(jobId, set)
  }

  /** The `exp` claim, with a margin. A token with no `exp` or no JWT form is not live. */
  private liveByClaims(grant: string): boolean {
    try {
      const exp = decodeGrantClaims(grant).exp
      return exp === 0 || exp * 1000 > this.clock() + GRANT_MARGIN_MS
    } catch {
      return false
    }
  }

  /** True when the token has an `exp` that is still in the future. A token that is not a JWT is not. */
  private notYetExpired(token: string): boolean {
    try {
      const exp = decodeGrantClaims(token).exp
      return exp !== 0 && exp * 1000 > this.clock()
    } catch {
      return false
    }
  }

  /** Whether `grant`, as renewed, is a grant of a turn that can still make a call. The first call starts the renewal. */
  isLive(grant: string | undefined): grant is string {
    return !!grant && this.grantLive(this.currentOf(grant))
  }

  private recordFile(jobId: string, repoName: string): string {
    return join(this.opts.stateDir, "workspaces", jobId, `${repoName}.json`)
  }

  private async loadRecord(jobId: string, repoName: string): Promise<RepoRecord | undefined> {
    const key = `${jobId}/${repoName}`
    const held = this.records.get(key)
    if (held) return held
    try {
      const rec = JSON.parse(await readFile(this.recordFile(jobId, repoName), "utf8")) as RepoRecord
      this.records.set(key, rec)
      return rec
    } catch {
      return undefined
    }
  }

  private async saveRecord(jobId: string, repoName: string, rec: RepoRecord): Promise<void> {
    this.records.set(`${jobId}/${repoName}`, rec)
    const file = this.recordFile(jobId, repoName)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify(rec), { encoding: "utf8", mode: 0o600 })
  }

  /** The whole listing of the base branch, page by page. A truncated tree is refused. */
  private async readTree(grant: string, repo: JobRepository): Promise<Record<string, TreeEntry>> {
    const listing: Record<string, TreeEntry> = {}
    const seen = new Set<string>()
    let cursor = ""
    for (;;) {
      const page = ((await this.opts.tools(grant, repo.connectorRef, "list_tree", { project: repo.project, ref: repo.baseBranch, ...(cursor ? { cursor } : {}) })) ?? {}) as TreePage
      if (page.truncated) {
        throw new DeliveryRefused(
          `The host cut the tree of ${repo.project} at ${repo.baseBranch}${page.reason ? ` (${page.reason})` : ""}. The workspace needs the whole listing, and a fix built on a partial tree is never delivered. ` +
            "Scope the job to a smaller repository.",
        )
      }
      for (const e of page.entries ?? []) listing[e.path] = e
      cursor = page.next_cursor ?? ""
      if (!cursor) return listing
      if (seen.has(cursor)) throw new Error(`list_tree for ${repo.project} returned the cursor ${JSON.stringify(cursor)} twice`)
      seen.add(cursor)
    }
  }

  /** The record of a repository, or `undefined` when none exists or it belongs to another project or ref. */
  private async recordFor(jobId: string, repo: JobRepository): Promise<RepoRecord | undefined> {
    const rec = await this.loadRecord(jobId, repo.name)
    if (!rec) return undefined
    return rec.project === repo.project && rec.ref === repo.baseBranch ? rec : undefined
  }

  /**
   * One sparse repository for each repository of the job, on `job/<job_id>`.
   * `grant` is a grant of a turn of this job. Without one the workspace is made
   * empty and unread, and a later call with a turn grant reads the listing. A
   * resumed job whose directory is gone, and a record that belongs to another
   * project or ref, give a new workspace and a note that earlier edits were lost.
   * The call also starts the renewal of the grant, so it stays live for the turn.
   */
  async prepare(jobId: string, repos: JobRepository[], grant: string | undefined, opts: { resumed: boolean }): Promise<Worktree[]> {
    assertNames(jobId, repos)
    const out: Worktree[] = []
    // A job with no repository needs no grant, and opens no harness.
    if (repos.length > 0) this.track(jobId, grant)
    const live = repos.length > 0 && this.isLive(grant)
    for (const repo of repos) {
      assertGitArgument("base branch", repo.baseBranch)
      const path = worktreePath(this.opts.root, jobId, repo.name)
      const branch = jobBranch(jobId)
      const notes: string[] = []
      const held = await this.loadRecord(jobId, repo.name)
      let rec = await this.recordFor(jobId, repo)
      let present = false
      try {
        present = (await stat(join(path, ".git"))).isDirectory()
      } catch {
        present = false
      }
      if (!present || !rec) {
        if (opts.resumed || held) {
          notes.push(
            "Your earlier edits to this repository were lost when the sandbox restarted. The worktree is new and holds none of them. Make the edits again. Never assume an earlier edit is on disk.",
          )
        }
        // A directory with no record, or a record of another project or ref, cannot be checked against a base. Start again.
        this.records.delete(`${jobId}/${repo.name}`)
        await rm(path, { recursive: true, force: true })
        await mkdir(path, { recursive: true })
        await git(["init", "--quiet", `--initial-branch=${branch}`], path)
        rec = { project: repo.project, ref: repo.baseBranch, listing: null, fetched: {} }
        await this.saveRecord(jobId, repo.name, rec)
      }
      if (rec.listing === null) {
        if (!live || !grant) {
          notes.push("The repository is not read yet: this turn has no live grant of the job. fetch_file refuses until a turn with a grant arrives. Do not edit repository files now.")
        } else {
          await this.loadListing(jobId, repo, rec, path, grant)
          const named = [...new Set(repo.paths ?? [])]
          this.log(`read ${repo.name}: ${Object.keys(rec.listing!).length} listed, ${named.length} files named by the job`)
          await inPool(named, READ_CONCURRENCY, async (p) => {
            const res = await this.fetchOne(jobId, repo, rec!, path, p, grant)
            if (!res.ok) notes.push(`The job names ${p}, and it was not fetched: ${res.text}`)
          })
        }
      }
      out.push({ repository: repo.name, path, branch, deliverable: repo.deliverable, notes })
    }
    return out
  }

  /**
   * The member tool `fetch_file`: read one listed file under the grant of the
   * turn, write it into the work tree, and record it as the base of its path.
   * A file the connector refuses is never written, and the refusal text goes
   * back to Claude.
   */
  async fetchFile(jobId: string, repos: JobRepository[], repoName: string | undefined, file: string, grant: string | undefined): Promise<{ ok: boolean; text: string }> {
    assertNames(jobId, repos)
    const repo = repoName ? repos.find((r) => r.name === repoName) : repos.length === 1 ? repos[0] : undefined
    if (!repo) return { ok: false, text: `Name the repository. This job has: ${repos.map((r) => r.name).join(", ") || "none"}.` }
    const rec = await this.recordFor(jobId, repo)
    if (!rec) return { ok: false, text: "The workspace is not prepared for this project and ref." }
    this.track(jobId, grant)
    if (!this.isLive(grant)) return { ok: false, text: "This turn has no live grant of the job, so the file cannot be read. Wait for the next turn." }
    if (rec.listing === null) {
      try {
        await this.loadListing(jobId, repo, rec, worktreePath(this.opts.root, jobId, repo.name), grant)
      } catch (e) {
        return { ok: false, text: (e as Error).message }
      }
    }
    return this.fetchOne(jobId, repo, rec, worktreePath(this.opts.root, jobId, repo.name), file, grant)
  }

  /**
   * Read the listing of the base branch and, with it, every listed `.gitignore`
   * (root and nested). The wrap-up needs them to tell a change from a build
   * output. The one method serves `prepare` and `fetch_file`, so a listing read
   * by either way is always complete. A `.gitignore` that cannot be read stops
   * the workspace, because the filter would be wrong.
   */
  private async loadListing(jobId: string, repo: JobRepository, rec: RepoRecord, dir: string, grant: string): Promise<void> {
    const listing = await this.readTree(grant, repo)
    const ignores = Object.values(listing)
      .filter((e) => e.type === "file" && (e.path === ".gitignore" || e.path.endsWith("/.gitignore")) && safeTreePath(e.path))
      .map((e) => e.path)
    rec.listing = listing
    await inPool(ignores, READ_CONCURRENCY, async (p) => {
      const res = await this.fetchOne(jobId, repo, rec, dir, p, grant)
      if (!res.ok) {
        rec.listing = null
        throw new DeliveryRefused(`The file ${p} cannot be read: ${res.text} Without it the workspace cannot tell a change from a build output, so no change is delivered.`)
      }
    })
    await this.saveRecord(jobId, repo.name, rec)
  }

  /** Make the folders above `rel` inside `dir`. A symbolic link or a file on the way is refused, so no write leaves the work tree. */
  private async safeParents(dir: string, rel: string): Promise<string | undefined> {
    const root = await realpath(dir)
    let at = dir
    for (const part of rel.split("/").slice(0, -1)) {
      at = join(at, part)
      let st
      try {
        st = await lstat(at)
      } catch {
        await mkdir(at)
        continue
      }
      if (st.isSymbolicLink()) return `${at.slice(dir.length + 1)} is a symbolic link`
      if (!st.isDirectory()) return `${at.slice(dir.length + 1)} is a file, not a folder`
    }
    const parent = await realpath(dirname(join(dir, rel)))
    if (parent !== root && !parent.startsWith(root + sep)) return "the folder is outside the worktree"
    return undefined
  }

  private async fetchOne(jobId: string, repo: JobRepository, rec: RepoRecord, dir: string, file: string, grant: string): Promise<{ ok: boolean; text: string }> {
    if (!safeTreePath(file)) return { ok: false, text: `${JSON.stringify(file)} is not a path inside the repository.` }
    const entry = rec.listing?.[file]
    if (!entry) return { ok: true, text: `${file} is not in the repository at ${rec.ref}. Create it by writing the file.` }
    if (entry.type !== "file") return { ok: false, text: `The path is not a regular file: ${file} is a ${entry.type}. The merge request cannot change it.` }
    if (rec.fetched[file]) return { ok: true, text: `${file} is already in the worktree. Edit the file.` }
    let res: ReadFileResult
    try {
      res = ((await this.opts.tools(grant, repo.connectorRef, "read_file", { project: repo.project, ref: repo.baseBranch, path: file })) ?? {}) as ReadFileResult
    } catch (e) {
      if (isRefusedFile(e)) return { ok: false, text: `${(e as Error).message} The file stays out of the worktree and out of the merge request.` }
      throw e
    }
    if (!res.found || typeof res.content !== "string") return { ok: false, text: `The base branch moved: ${file} is in the listing, and read_file did not find it.` }
    if (entry.sha && res.sha !== entry.sha) return { ok: false, text: `The base branch moved: ${file} changed since the listing. Its sha was ${entry.sha} and is now ${res.sha ?? "unknown"}.` }
    const bytes = Buffer.from(res.content, "utf8")
    const target = join(dir, file)
    const escape = await this.safeParents(dir, file)
    if (escape) return { ok: false, text: `${file} was not written: ${escape}. Remove it and fetch the file again.` }
    try {
      if ((await lstat(target)).isSymbolicLink()) return { ok: false, text: `${file} was not written: it is a symbolic link in the worktree. Remove it and fetch the file again.` }
    } catch {
      // nothing at the target
    }
    await writeFile(target, bytes)
    if (entry.mode === "100755") await chmod(target, 0o755)
    rec.fetched[file] = { sha: res.sha ?? entry.sha ?? "", hash: sha256(bytes), mode: entry.mode === "100755" ? "100755" : "100644" }
    await this.saveRecord(jobId, repo.name, rec)
    return { ok: true, text: `${file} is in the worktree. Edit it there.` }
  }

  /**
   * The change of the work tree against the record, as the files of
   * `open_merge_request`. The candidates are the fetched files and the files
   * that git lists as not ignored, with the `.gitignore` files of the
   * repository in force. A build output, a venv and a cache are ignored, and a
   * nested repository is never entered.
   */
  private async collect(jobId: string, repo: JobRepository): Promise<FileChange[]> {
    const dir = worktreePath(this.opts.root, jobId, repo.name)
    const rec = await this.recordFor(jobId, repo)
    if (!rec) throw new DeliveryRefused(`The workspace of ${repo.name} has no record of its base for ${repo.project} at ${repo.baseBranch}. No change can be delivered.`)
    const listing = rec.listing
    const changes: FileChange[] = []
    const unfetched: string[] = []
    const notRegular: string[] = []
    const modeChanged: string[] = []
    const notText: string[] = []
    const conflicts: string[] = []
    const tooBig: string[] = []
    const dirs = new Set<string>()
    if (listing) for (const p of Object.keys(listing)) for (const a of ancestors(p)) dirs.add(a)
    let total = 0

    // The index is the driver's own and empty, outside the worktree. The agent's index and HEAD do not
    // count: a file it staged or committed is still listed as not in the (empty) index.
    const indexFile = join(this.opts.stateDir, "index", jobId, `${repo.name}.idx`)
    await mkdir(dirname(indexFile), { recursive: true, mode: 0o700 })
    await rm(indexFile, { force: true })
    const others = (await git(["ls-files", "--others", "--exclude-standard", "-z"], dir, { GIT_INDEX_FILE: indexFile })).split("\0").filter(Boolean)
    await rm(indexFile, { force: true })
    if (others.length > MAX_WALK_FILES) {
      throw new DeliveryRefused(`The workspace holds ${others.length} files that no .gitignore excludes, which is not a change a merge request can carry. Remove the files you did not mean to add, or ignore them.`)
    }
    const candidates = new Set<string>(others)
    for (const p of Object.keys(rec.fetched)) candidates.add(p)

    const consider = async (rel: string, base: Fetched | undefined): Promise<void> => {
      const abs = join(dir, rel)
      if (rel.endsWith("/")) {
        notRegular.push(`${rel} (a nested git repository)`)
        return
      }
      let st
      try {
        st = await lstat(abs)
      } catch {
        if (base) changes.push({ path: rel, delete: true })
        return
      }
      if (!st.isFile()) {
        notRegular.push(rel)
        return
      }
      const exec = (st.mode & 0o111) !== 0
      const entry = listing?.[rel]
      if (base) {
        if (base.mode === "100755" && !exec) {
          modeChanged.push(`${rel} (100755 to 100644, and the tool would keep 100755)`)
          return
        }
        if (base.mode === "100644" && exec) {
          modeChanged.push(`${rel} (100644 to 100755, and the tool writes 100644)`)
          return
        }
        const buf = await readFile(abs)
        if (sha256(buf) === base.hash) return
        const text = textOf(buf)
        if (text === undefined) notText.push(rel)
        else {
          if (buf.length > MAX_FILE_BYTES) tooBig.push(`${rel} (${buf.length} bytes)`)
          total += buf.length
          changes.push({ path: rel, content: text })
        }
        return
      }
      if (entry && entry.type !== "file") {
        notRegular.push(`${rel} (the path is not a regular file: it is a ${entry.type} in the repository)`)
        return
      }
      if (entry || !listing) {
        unfetched.push(rel)
        return
      }
      // A new path: nothing at it, nothing above it that is not a folder, nothing below it.
      const blocker = ancestors(rel).find((a) => listing[a] && listing[a]!.type !== "dir")
      if (blocker) {
        conflicts.push(`${rel} (below ${blocker}, which is a ${listing[blocker]!.type})`)
        return
      }
      if (dirs.has(rel)) {
        conflicts.push(`${rel} (the repository has a folder at that path)`)
        return
      }
      if (exec) {
        modeChanged.push(`${rel} (new executable file, and the tool writes 100644)`)
        return
      }
      const buf = await readFile(abs)
      const text = textOf(buf)
      if (text === undefined) {
        notText.push(rel)
        return
      }
      if (buf.length > MAX_FILE_BYTES) tooBig.push(`${rel} (${buf.length} bytes)`)
      total += buf.length
      changes.push({ path: rel, content: text })
    }
    for (const rel of candidates) await consider(rel, rec.fetched[rel])

    const refusals: string[] = []
    if (unfetched.length > 0) refusals.push(`These files exist in the repository, or the repository was not read, and you never fetched them with fetch_file: ${listed(unfetched)}. Fetch a file before you change it.`)
    if (conflicts.length > 0) refusals.push(`These paths collide with the repository: ${listed(conflicts)}.`)
    if (notRegular.length > 0) refusals.push(`These are not regular files, and the tool cannot write them: ${listed(notRegular)}.`)
    if (modeChanged.length > 0) refusals.push(`The tool cannot take these mode changes: ${listed(modeChanged)}.`)
    if (changes.length > MAX_FILES) refusals.push(`The change has ${changes.length} files. The limit of open_merge_request is ${MAX_FILES}.`)
    if (tooBig.length > 0) refusals.push(`These files are over ${MAX_FILE_BYTES} bytes, the limit for one file: ${listed(tooBig)}.`)
    if (total > MAX_TOTAL_BYTES) refusals.push(`The files add up to ${total} bytes. The limit for all files is ${MAX_TOTAL_BYTES}.`)
    if (notText.length > 0) refusals.push(`These files are not UTF-8 text, and the tool takes text only: ${listed(notText)}.`)
    if (refusals.length > 0) {
      throw new DeliveryRefused(`The merge request was not opened. ${refusals.join(" ")} Make a smaller change of regular text files, and close the job again.`)
    }
    return changes
  }

  /** Read every changed path again. The base branch must be the one the work started from. */
  private async checkBase(jobId: string, repo: JobRepository, changes: FileChange[], grant: string): Promise<void> {
    const rec = await this.recordFor(jobId, repo)
    if (!rec) throw new DeliveryRefused(`The workspace of ${repo.name} has no record of its base for ${repo.project} at ${repo.baseBranch}.`)
    const moved: string[] = []
    await inPool(changes, READ_CONCURRENCY, async (c) => {
      const base = rec.fetched[c.path]
      let res: ReadFileResult
      try {
        res = ((await this.opts.tools(grant, repo.connectorRef, "read_file", { project: repo.project, ref: repo.baseBranch, path: c.path })) ?? {}) as ReadFileResult
      } catch (e) {
        if (isRefusedFile(e)) {
          moved.push(c.path)
          return
        }
        throw e
      }
      if (base ? !res.found || res.sha !== base.sha : res.found) moved.push(c.path)
    })
    if (moved.length > 0) {
      throw new DeliveryRefused(`The base branch moved: ${listed(moved.sort())} changed on ${repo.baseBranch} since the work started. The merge request was not opened. Start the change again from the new base.`)
    }
  }

  /**
   * Wrap up one job. First every repository is checked: the change, the limits
   * and the base. If any repository is refused or cannot be checked, nothing is
   * opened. Then one merge request per repository is opened. The workspace is
   * not removed here: the caller removes it after a success or a permanent
   * refusal, and keeps it for an outcome that is `retryable`.
   *
   * `grant` must be a live grant of a turn of the job. Without one nothing runs
   * and each outcome is retryable.
   */
  async wrapUp(jobId: string, repos: JobRepository[], opts: { push: boolean; title: string; description: string; grant: string | undefined }): Promise<WrapUpOutcome[]> {
    assertNames(jobId, repos)
    const branch = jobBranch(jobId)
    const outcomes = repos.map(
      (repo): WrapUpOutcome => ({ repository: repo.name, branch, deliverable: repo.deliverable, files: 0, mergeRequest: "", mergeRequestUrl: "", error: "", failed: false, retryable: false }),
    )
    const active = repos.map((repo, i) => ({ repo, out: outcomes[i]! })).filter((x) => x.repo.deliverable !== "NONE")
    if (active.length === 0) return outcomes
    if (!opts.push) {
      for (const { out } of active) out.error = "abandoned: no merge request opened"
      return outcomes
    }

    const grant = opts.grant
    this.track(jobId, grant)
    if (!this.isLive(grant)) {
      // A grant that is gone, or whose `exp` has passed, is permanent: no try inside the close brings it back.
      // A grant that is still before `exp` but inside the margin may be renewed in a moment.
      const retryable = !!grant && this.notYetExpired(this.currentOf(grant))
      for (const { out } of active) Object.assign(out, { error: "No live grant of a turn of this job is held, so the merge request cannot be opened now.", failed: true, retryable })
      return outcomes
    }

    // Phase one: collect and check every repository. Open nothing until all pass.
    const plans = new Map<string, FileChange[]>()
    for (const { repo, out } of active) {
      try {
        assertGitArgument("base branch", repo.baseBranch)
        const files = await this.collect(jobId, repo)
        out.files = files.length
        if (files.length > 0) {
          if (repo.deliverable === "PUSH_BRANCH") {
            throw new DeliveryRefused("The deliverable PUSH_BRANCH is not supported. The sandbox holds no forge credential, and the connector has no tool that pushes a branch. Use the deliverable MERGE_REQUEST.")
          }
          await this.checkBase(jobId, repo, files, grant)
        }
        plans.set(repo.name, files)
      } catch (e) {
        Object.assign(out, { error: (e as Error).message, failed: true, retryable: isTransient(e) })
      }
    }
    if (active.some(({ out }) => out.failed)) {
      for (const { out } of active) {
        if (!out.failed) Object.assign(out, { error: "Not opened: another repository of this job was refused or could not be checked, and a job delivers all of its repositories or none.", failed: true, retryable: active.some((x) => x.out.retryable) })
      }
      return outcomes
    }

    // Phase two: open. A failure after an open names the merge requests that exist.
    const opened: string[] = []
    for (const { repo, out } of active) {
      const files = plans.get(repo.name) ?? []
      if (files.length === 0) {
        this.log(`${repo.name}: no change against the base, no merge request`)
        continue
      }
      try {
        const result = (await this.opts.tools(grant, repo.connectorRef, "open_merge_request", {
          project: repo.project,
          base_branch: repo.baseBranch,
          branch,
          title: cutBytes(opts.title.replace(/\s+/g, " ").trim(), MAX_TITLE_BYTES),
          description: cutBytes(opts.description, MAX_DESCRIPTION_BYTES),
          files,
        })) as { merge_request?: unknown; url?: unknown } | undefined
        if (typeof result?.merge_request !== "string" || result.merge_request === "" || typeof result.url !== "string") {
          throw new Error("open_merge_request returned no merge_request key and no url")
        }
        out.mergeRequest = result.merge_request
        out.mergeRequestUrl = result.url
        opened.push(`${repo.name}: ${result.merge_request} ${result.url}`)
      } catch (e) {
        out.failed = true
        out.retryable = isTransient(e)
        out.error = `${(e as Error).message}${opened.length > 0 ? ` The job failed after these merge requests were opened: ${opened.join("; ")}.` : ""}`
        // The rest of the repositories are not opened after a failure.
        for (const { out: rest } of active) {
          if (!rest.failed && !rest.mergeRequest && rest !== out) Object.assign(rest, { error: "Not opened: an earlier repository of this job failed.", failed: true, retryable: out.retryable })
        }
        break
      }
    }
    return outcomes
  }

  /** Remove the job's directory and its record. Nothing else deletes a workspace (glossary, Close). */
  async remove(jobId: string, repos: { name: string }[]): Promise<void> {
    assertNames(jobId, repos)
    for (const r of repos) this.records.delete(`${jobId}/${r.name}`)
    // The job is over: stop the harness of each grant it used, and with it the renewal timer.
    for (const grant of this.grantsOf.get(jobId) ?? []) this.releaseGrant(grant)
    this.grantsOf.delete(jobId)
    await rm(join(this.opts.root, "jobs", jobId), { recursive: true, force: true })
    await rm(join(this.opts.stateDir, "workspaces", jobId), { recursive: true, force: true })
    await rm(join(this.opts.stateDir, "index", jobId), { recursive: true, force: true })
  }
}
