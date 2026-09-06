// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"

/**
 * The snippets in `hosts/` are the install path for every coding agent with
 * no bundle (ADR-0008, slice A8). They are the product for those hosts, so
 * their shape is asserted here. Cursor and Windsurf have no headless mode,
 * so this is the only check they get; Codex CLI and Gemini CLI are also
 * driven for real by `host-smoke.yml`.
 */
const HOSTS_DIR = new URL("../../../hosts/", import.meta.url)

const read = (name: string): Promise<string> => readFile(fileURLToPath(new URL(name, HOSTS_DIR)), "utf8")

/** The fenced block of one language, the way the CI workflow extracts it. */
function fenced(markdown: string, language: string): string {
  const start = markdown.indexOf("```" + language + "\n")
  assert.notEqual(start, -1, `no ${language} block`)
  const from = start + language.length + 4
  const end = markdown.indexOf("```", from)
  assert.notEqual(end, -1, "unterminated block")
  return markdown.slice(from, end)
}

/**
 * The Codex snippet is TOML, and node has no TOML parser. The reader below
 * covers the four shapes this file uses: a table header, a string, a string
 * array, and a nested env table.
 */
function readCodexToml(toml: string): { command: string; args: string[]; env: Record<string, string> } {
  const out = { command: "", args: [] as string[], env: {} as Record<string, string> }
  let table = ""
  for (const raw of toml.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      table = header[1]!
      continue
    }
    const pair = /^([A-Za-z0-9_.]+)\s*=\s*(.+)$/.exec(line)
    if (!pair) continue
    const key = pair[1]!
    const value = pair[2]!
    if (table === "mcp_servers.gibson.env") {
      out.env[key] = JSON.parse(value) as string
      continue
    }
    if (table !== "mcp_servers.gibson") continue
    if (key === "command") out.command = JSON.parse(value) as string
    if (key === "args") out.args = JSON.parse(value) as string[]
  }
  return out
}

/** What every snippet must say, whatever the host's file format. */
function assertGibsonServer(server: { command: string; args: string[]; env?: Record<string, string> }, host: string): void {
  assert.equal(server.command, "npx", `${host}: the snippet runs the published server`)
  assert.ok(server.args.some((a) => a.startsWith("@zeroroot-ai/gibson-mcp")), `${host}: names the shared package`)
  assert.ok(server.args.includes("gibson-mcp"), `${host}: names the bin`)
  assert.deepEqual(server.args.slice(-2), ["--transport", "stdio"], `${host}: a host that spawns the server speaks stdio`)
  assert.ok(server.args.includes("--yes"), `${host}: npx must not stop to ask`)
}

for (const host of ["cursor", "gemini", "windsurf"]) {
  test(`the ${host} snippet starts the Gibson MCP server over stdio`, async () => {
    const config = JSON.parse(fenced(await read(`${host}.md`), "json")) as { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> }
    assert.deepEqual(Object.keys(config.mcpServers), ["gibson"], `${host}: one server`)
    assertGibsonServer(config.mcpServers.gibson!, host)
    assert.ok(config.mcpServers.gibson!.env?.GIBSON_PLATFORM_URL, `${host}: shows where the platform is named`)
  })
}

test("the codex snippet is a TOML table that says the same thing", async () => {
  const server = readCodexToml(fenced(await read("codex.md"), "toml"))
  assertGibsonServer(server, "codex")
  assert.ok(server.env.GIBSON_PLATFORM_URL, "codex: shows where the platform is named")
})

test("every host file the index lists exists, and every file is listed", async () => {
  const index = await read("README.md")
  const listed = [...index.matchAll(/\]\((\w+)\.md\)/g)].map((m) => m[1]!)
  assert.deepEqual(listed.sort(), ["codex", "cursor", "gemini", "windsurf"])
  for (const host of listed) await read(`${host}.md`)
})

test("no snippet carries a credential, only the addresses of things", async () => {
  for (const host of ["cursor", "codex", "gemini", "windsurf", "README"]) {
    const body = await read(`${host}.md`)
    assert.ok(!/GIBSON_CG_JWT\s*[=:]/.test(body), `${host}: a grant is never written into a config file`)
    assert.ok(!/sk-[a-z]/.test(body), `${host}: no key`)
  }
})
