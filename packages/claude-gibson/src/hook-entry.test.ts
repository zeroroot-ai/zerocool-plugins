// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

/**
 * The hook entry `hooks/zerocool-claude-hook.mjs`, run as Claude Code runs it:
 * `node <path>` with the hook input on stdin. A fake `npx` first on PATH
 * records what it was asked to run and what it read.
 */
const ENTRY = fileURLToPath(new URL("../hooks/zerocool-claude-hook.mjs", import.meta.url))

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function run(path: string, stdin: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, PATH: path }, stdio: ["pipe", "pipe", "pipe"] })
    const out: string[] = []
    const err: string[] = []
    child.stdout.on("data", (d: Buffer) => out.push(d.toString()))
    child.stderr.on("data", (d: Buffer) => err.push(d.toString()))
    child.on("error", reject)
    child.on("exit", (code) => resolve({ code, stdout: out.join(""), stderr: err.join("") }))
    child.stdin.end(stdin)
  })
}

test("the entry runs the hook bin through npx at the pinned version, with stdin passed through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-hook-"))
  try {
    const record = join(dir, "record.json")
    await writeFile(join(dir, "npx"), `#!/bin/sh\ncat > "${dir}/stdin.txt"\nprintf '%s\\n' "$@" > "${record}"\necho hook-output\nexit 0\n`)
    await chmod(join(dir, "npx"), 0o755)
    const r = await run(`${dir}${delimiter}${process.env.PATH ?? ""}`, '{"hook_event_name":"SessionStart"}')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, "hook-output\n", "the bin's stdout is the hook's stdout")
    const argv = (await readFile(record, "utf8")).trim().split("\n")
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }
    assert.deepEqual(argv, ["--yes", "--package", `@zeroroot-ai/zerocool-claude@${pkg.version}`, "zerocool-claude-hook"])
    assert.equal(await readFile(join(dir, "stdin.txt"), "utf8"), '{"hook_event_name":"SessionStart"}', "the hook input reaches the bin")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the bin's exit code is the hook's exit code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-hook-"))
  try {
    await writeFile(join(dir, "npx"), "#!/bin/sh\nexit 3\n")
    await chmod(join(dir, "npx"), 0o755)
    const r = await run(`${dir}${delimiter}${process.env.PATH ?? ""}`, "")
    assert.equal(r.code, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("no npx on PATH fails open with the reason, like the bin itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-hook-"))
  try {
    const r = await run(dir, "")
    assert.equal(r.code, 0)
    assert.match(r.stderr, /cannot run npx/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
