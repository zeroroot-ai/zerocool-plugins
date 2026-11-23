// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { execFile } from "node:child_process"
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { ToolCallError, type ToolCaller } from "./connector-tools.js"
import type { Deliverable, JobRepository } from "./job.js"

const execFileAsync = promisify(execFile)

/**
 * The workspace manager (glossary, Workspace manager; zerocool-plugins#106).
 *
 * The member holds no forge credential and runs no git transport. An untrusted
 * sandboxed agent holds no tenant secret, and the daemon refuses to give it
 * one. The workspace reads and delivers through the governed connector tools:
 *
 *   prepare   `list_tree` and `read_file` write the base tree of the repository,
 *             then a local `git init` commits it as the base. No remote, no token.
 *   wrap-up   the diff against the base becomes one `open_merge_request` call,
 *             on the branch `job/<job id>`.
 *
 * Layout under the root (`ZEROCOOL_WORKSPACE`, default `/workspace`):
 *
 *   jobs/<job_id>/<repo name>   one local repository per repository per job
 *
 * The daemon binds a fix to its job only when `open_merge_request` opened the
 * merge request, so a pushed branch would never link. There is no push path.
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
  /** Files in the change: the files of the `open_merge_request` call. */
  files: number
  /** The `merge_request` key of the tool result, when a merge request was opened. */
  mergeRequest: string
  mergeRequestUrl: string
  /** Set when the deliverable was not performed. The text names the refusal. */
  error: string
}

/** The limits of `open_merge_request` (connectors README, Git host contract). */
export const MAX_FILES = 100
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** The local ref of the base commit. A commit of the agent never moves it. */
const BASE_REF = "refs/zerocool/base"

/** How many `read_file` calls run at once. */
const READ_CONCURRENCY = 8

/**
 * A delivery the workspace refuses on purpose: a truncated tree, a change over
 * a limit of the tool, a file the tool cannot take. The message is the result
 * of the job. It says what to change.
 */
export class DeliveryRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeliveryRefused"
  }
}

export interface WorkspaceOptions {
  root: string
  /** Calls a connector tool under the grant of the turn. */
  tools: ToolCaller
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
function assertNames(jobId: string, repos: JobRepository[]): void {
  assertGitArgument("job id", jobId, { path: true })
  for (const repo of repos) assertGitArgument("repository name", repo.name, { path: true })
}

/** Local git only. The child gets no credential and no environment of the member. */
async function git(args: string[], cwd: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  }
  const full = ["-c", "user.name=zerocool member", "-c", "user.email=member@zeroroot.ai", "-c", "commit.gpgsign=false", "-c", "core.quotepath=off", ...args]
  try {
    const { stdout } = await execFileAsync("git", full, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
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
}

/** A path from the connector is one relative path with no `..`, no `.git` folder and no empty folder name. */
function safeTreePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git")
}

/** `read_file` refuses a file that is not UTF-8 text or is over its limit. The base tree leaves such a file out. */
function isUnreadableFile(e: unknown): boolean {
  return e instanceof ToolCallError && /utf-?8|binary|not text|too large|1 ?mib/i.test(e.message)
}

async function inPool<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, runner))
}

interface FileChange {
  path: string
  content?: string
  delete?: true
}

/** The text of a changed file, or the reason the tool cannot take it. */
function textOf(buf: Buffer): string | undefined {
  if (buf.includes(0)) return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    return undefined
  }
}

function listed(paths: string[]): string {
  return paths.slice(0, 5).join(", ") + (paths.length > 5 ? `, and ${paths.length - 5} more` : "")
}

export class WorkspaceManager {
  private readonly log: (line: string) => void

  constructor(private readonly opts: WorkspaceOptions) {
    this.log = opts.log ?? (() => {})
  }

  /** The whole tree of the base branch, page by page. A truncated tree is refused. */
  private async readTree(grant: string, repo: JobRepository): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = []
    const seen = new Set<string>()
    let cursor = ""
    for (;;) {
      const page = ((await this.opts.tools(grant, repo.connectorRef, "list_tree", { project: repo.project, ref: repo.baseBranch, ...(cursor ? { cursor } : {}) })) ?? {}) as TreePage
      if (page.truncated) {
        throw new DeliveryRefused(
          `The host cut the tree of ${repo.project} at ${repo.baseBranch}${page.reason ? ` (${page.reason})` : ""}. The workspace needs the whole tree, and a fix built on a partial tree is never delivered. ` +
            "Scope the job to a smaller repository.",
        )
      }
      entries.push(...(page.entries ?? []))
      cursor = page.next_cursor ?? ""
      if (!cursor) return entries
      if (seen.has(cursor)) throw new Error(`list_tree for ${repo.project} returned the cursor ${JSON.stringify(cursor)} twice`)
      seen.add(cursor)
    }
  }

  /**
   * One local repository per repository for the job, on `job/<job_id>`. The
   * base commit holds the tree of the base branch. A resumed job keeps its
   * repository, with the work of the earlier turns.
   */
  async prepare(jobId: string, repos: JobRepository[], grant: string): Promise<Worktree[]> {
    assertNames(jobId, repos)
    const out: Worktree[] = []
    for (const repo of repos) {
      assertGitArgument("base branch", repo.baseBranch)
      const path = worktreePath(this.opts.root, jobId, repo.name)
      const branch = jobBranch(jobId)
      let present = false
      try {
        present = (await stat(join(path, ".git"))).isDirectory()
      } catch {
        present = false
      }
      if (!present) await this.build(repo, path, branch, grant)
      out.push({ repository: repo.name, path, branch, deliverable: repo.deliverable })
    }
    return out
  }

  /** Build the tree beside the final path and move it into place, so a failure leaves no half tree. */
  private async build(repo: JobRepository, path: string, branch: string, grant: string): Promise<void> {
    const staging = `${path}.partial`
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      const entries = await this.readTree(grant, repo)
      const files = entries.filter((e) => e.type === "file")
      const skipped = entries.length - files.length
      if (skipped > 0) this.log(`${repo.name}: ${skipped} entries that are not regular files stay out of the workspace`)
      const readable = files.filter((e) => {
        if (!safeTreePath(e.path)) {
          this.log(`${repo.name}: the path ${JSON.stringify(e.path)} is not safe and stays out of the workspace`)
          return false
        }
        if ((e.size ?? 0) > MAX_FILE_BYTES) {
          this.log(`${repo.name}: ${e.path} is over ${MAX_FILE_BYTES} bytes and stays out of the workspace`)
          return false
        }
        return true
      })
      this.log(`read ${repo.name}: ${readable.length} files through read_file`)
      await inPool(readable, READ_CONCURRENCY, async (e) => {
        let res: ReadFileResult
        try {
          res = ((await this.opts.tools(grant, repo.connectorRef, "read_file", { project: repo.project, ref: repo.baseBranch, path: e.path })) ?? {}) as ReadFileResult
        } catch (err) {
          if (!isUnreadableFile(err)) throw err
          this.log(`${repo.name}: ${e.path} is not readable as text and stays out of the workspace`)
          return
        }
        if (!res.found || typeof res.content !== "string") throw new Error(`read_file did not find ${e.path} at ${repo.baseBranch} though list_tree named it`)
        const target = join(staging, e.path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, res.content, "utf8")
        if (e.mode === "100755") await chmod(target, 0o755)
      })
      await git(["init", "--quiet", `--initial-branch=${branch}`], staging)
      await git(["add", "-A"], staging)
      await git(["commit", "--quiet", "--allow-empty", "-m", `base: ${repo.project} at ${repo.baseBranch}`], staging)
      await git(["update-ref", BASE_REF, "HEAD"], staging)
      await mkdir(dirname(path), { recursive: true })
      await rename(staging, path)
    } catch (e) {
      await rm(staging, { recursive: true, force: true })
      throw e
    }
  }

  /** The change of the work tree against the base commit, as the files of `open_merge_request`. */
  private async collect(path: string): Promise<FileChange[]> {
    await git(["add", "-A"], path)
    const raw = await git(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", BASE_REF], path)
    const parts = raw.split("\0")
    const changes: FileChange[] = []
    const notRegular: string[] = []
    const notText: string[] = []
    const tooBig: string[] = []
    let total = 0
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const meta = parts[i]!.slice(1).split(" ")
      const file = parts[i + 1]!
      const oldMode = meta[0]
      const newMode = meta[1]
      if (newMode === "000000") {
        changes.push({ path: file, delete: true })
        continue
      }
      // The tool writes 100644, and keeps the mode of an existing 100755 file.
      if (newMode !== "100644" && !(newMode === "100755" && oldMode === "100755")) {
        notRegular.push(`${file} (mode ${newMode})`)
        continue
      }
      const buf = await readFile(join(path, file))
      const text = textOf(buf)
      if (text === undefined) {
        notText.push(file)
        continue
      }
      if (buf.length > MAX_FILE_BYTES) tooBig.push(`${file} (${buf.length} bytes)`)
      total += buf.length
      changes.push({ path: file, content: text })
    }
    const refusals: string[] = []
    if (changes.length > MAX_FILES) refusals.push(`The change has ${changes.length} files. The limit of open_merge_request is ${MAX_FILES}.`)
    if (tooBig.length > 0) refusals.push(`These files are over ${MAX_FILE_BYTES} bytes, the limit for one file: ${listed(tooBig)}.`)
    if (total > MAX_TOTAL_BYTES) refusals.push(`The files add up to ${total} bytes. The limit for all files is ${MAX_TOTAL_BYTES}.`)
    if (notText.length > 0) refusals.push(`These files are not UTF-8 text, and the tool takes text only: ${listed(notText)}.`)
    if (notRegular.length > 0) refusals.push(`The tool writes regular files, and keeps the mode of an existing executable file. It cannot take these changes: ${listed(notRegular)}.`)
    if (refusals.length > 0) {
      throw new DeliveryRefused(`The merge request was not opened. ${refusals.join(" ")} Make a smaller change of text files, and close the job again.`)
    }
    return changes
  }

  /**
   * Wrap up one job: compute the change against the base and open one merge
   * request with it, then remove the job directory. `push` false is the
   * abandon path: nothing is opened. A refusal comes back in `error`, never as
   * a silent skip.
   */
  async wrapUp(jobId: string, repos: JobRepository[], opts: { push: boolean; title: string; description: string; grant: string }): Promise<WrapUpOutcome[]> {
    assertNames(jobId, repos)
    const out: WrapUpOutcome[] = []
    for (const repo of repos) {
      const path = worktreePath(this.opts.root, jobId, repo.name)
      const branch = jobBranch(jobId)
      const outcome: WrapUpOutcome = { repository: repo.name, branch, deliverable: repo.deliverable, files: 0, mergeRequest: "", mergeRequestUrl: "", error: "" }
      try {
        if (repo.deliverable !== "NONE") {
          assertGitArgument("base branch", repo.baseBranch)
          const files = await this.collect(path)
          outcome.files = files.length
          if (files.length === 0) {
            this.log(`${repo.name}: no change against the base, no merge request`)
          } else if (!opts.push) {
            outcome.error = "abandoned: no merge request opened"
          } else if (repo.deliverable === "PUSH_BRANCH") {
            throw new DeliveryRefused(
              "The deliverable PUSH_BRANCH is not supported. The sandbox holds no forge credential, and the connector has no tool that pushes a branch. Use the deliverable MERGE_REQUEST.",
            )
          } else {
            const title = opts.title.replace(/\s+/g, " ").trim().slice(0, 200)
            const result = (await this.opts.tools(opts.grant, repo.connectorRef, "open_merge_request", {
              project: repo.project,
              base_branch: repo.baseBranch,
              branch,
              title,
              description: opts.description,
              files,
            })) as { merge_request?: unknown; url?: unknown } | undefined
            if (typeof result?.merge_request !== "string" || result.merge_request === "" || typeof result.url !== "string") {
              throw new Error("open_merge_request returned no merge_request key and no url")
            }
            outcome.mergeRequest = result.merge_request
            outcome.mergeRequestUrl = result.url
          }
        }
      } catch (e) {
        outcome.error = (e as Error).message
      }
      out.push(outcome)
    }
    await this.remove(jobId, repos)
    return out
  }

  /** Remove the job's directory. Nothing else deletes a workspace (glossary, Close). */
  async remove(jobId: string, repos: JobRepository[]): Promise<void> {
    assertNames(jobId, repos)
    await rm(join(this.opts.root, "jobs", jobId), { recursive: true, force: true })
  }
}
