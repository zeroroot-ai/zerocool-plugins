// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { spawn } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Run git with a credential that never touches disk.
 *
 * The token goes to the git child as `ZEROCOOL_GIT_TOKEN` in its environment
 * only. `GIT_ASKPASS` points at a two-line shell script that echoes the
 * username or the token from that environment. The script holds no secret.
 * `GIT_TERMINAL_PROMPT=0` makes a missing credential fail instead of hang.
 * No `-c http.extraheader` on argv: `/proc/<pid>/cmdline` is world readable.
 */
export interface GitCredential {
  username: string
  token: string
}

export interface GitRunOptions {
  cwd: string
  credential?: GitCredential
  askpassPath?: string
  env?: NodeJS.ProcessEnv
}

export interface GitResult {
  stdout: string
  stderr: string
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} exited ${exitCode}: ${scrub(stderr).trim().slice(0, 1000)}`)
    this.name = "GitError"
  }
}

/** Remove anything that looks like a URL credential from a git message. */
export function scrub(text: string): string {
  return text.replace(/(https?:\/\/)[^/@\s]+@/g, "$1<redacted>@")
}

export const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' "$ZEROCOOL_GIT_USERNAME" ;;
  *) printf '%s\\n' "$ZEROCOOL_GIT_TOKEN" ;;
esac
`

/** Write the askpass helper once, mode 0700. Returns its path. */
export async function ensureAskpass(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, "git-askpass.sh")
  await writeFile(path, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o700 })
  await chmod(path, 0o700)
  return path
}

/** The environment a git child gets. A credential adds the askpass wiring. */
export function gitEnv(opts: GitRunOptions): NodeJS.ProcessEnv {
  const base = opts.env ?? process.env
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    // A sandbox has no interactive user: no editor, no pager, no signing prompt.
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
  }
  delete env.ZEROCOOL_GIT_TOKEN
  delete env.ZEROCOOL_GIT_USERNAME
  delete env.GIT_ASKPASS
  if (opts.credential) {
    if (!opts.askpassPath) throw new Error("gitEnv: a credential needs the askpass helper path")
    env.GIT_ASKPASS = opts.askpassPath
    env.ZEROCOOL_GIT_USERNAME = opts.credential.username
    env.ZEROCOOL_GIT_TOKEN = opts.credential.token
  }
  return env
}

export type GitRunner = (args: string[], opts: GitRunOptions) => Promise<GitResult>

/** Spawn git. Rejects with a scrubbed message on a non-zero exit. */
export const runGit: GitRunner = (args, opts) =>
  new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", args, { cwd: opts.cwd, env: gitEnv(opts), stdio: ["ignore", "pipe", "pipe"] })
    const out: string[] = []
    const err: string[] = []
    child.stdout.on("data", (d: Buffer) => out.push(d.toString()))
    child.stderr.on("data", (d: Buffer) => err.push(d.toString()))
    child.on("error", (e) => reject(new Error(`cannot run git: ${e.message}`)))
    child.on("exit", (code) => {
      const stderr = err.join("")
      if (code !== 0) {
        reject(new GitError(args, code, stderr))
        return
      }
      resolve({ stdout: out.join(""), stderr })
    })
  })
