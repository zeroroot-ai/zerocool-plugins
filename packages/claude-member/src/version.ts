// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// The Claude Code version this driver was captured and tested against is the
// name of the fixture directory `test/fixtures/claude-code-<version>/`, and
// `Dockerfile.claude` installs it. A bump changes both in one PR (see
// `test/fixtures/README.md`, "Re-capture procedure").

/** Read the running CLI's version from `claude --version` output. */
export function parseClaudeVersion(stdout: string): string {
  // The first `digits.digits.digits` run. Splitting on everything that is not
  // a digit or a dot, then checking each piece, reads the text once; the old
  // unanchored `/(\d+\.\d+\.\d+)/` rescanned long digit runs (CodeQL
  // js/polynomial-redos, #13).
  for (const piece of stdout.split(/[^0-9.]+/)) {
    const parts = piece.split(".")
    while (parts.length && parts[0] === "") parts.shift()
    if (parts.length < 3) continue
    const [major, minor, patch] = parts
    if (major && minor && patch && isDigits(major) && isDigits(minor) && isDigits(patch)) return `${major}.${minor}.${patch}`
  }
  return ""
}

function isDigits(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 48 || c > 57) return false
  }
  return true
}

/** Ask the CLI what version it is. Empty when it cannot run. */
export async function readClaudeVersion(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const { spawn } = await import("node:child_process")
  const { resolveBin } = await import("./claude-run.js")
  const { command, prefix } = resolveBin(bin)
  return await new Promise<string>((resolve) => {
    const child = spawn(command, [...prefix, "--version"], { cwd, env, stdio: ["ignore", "pipe", "ignore"] })
    const out: string[] = []
    child.stdout.on("data", (d: Buffer) => out.push(d.toString()))
    child.on("error", () => resolve(""))
    child.on("exit", () => resolve(parseClaudeVersion(out.join(""))))
  })
}
