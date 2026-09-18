// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"

/**
 * Every install path runs a published package through `npx --yes`. That
 * command runs whatever the registry serves with no prompt, so the version in
 * each of these files must be exact. A floating tag such as `@latest` would
 * run one compromised publish on every developer machine at session start.
 *
 * Dependabot cannot read a version inside a JSON argument list, a Markdown
 * snippet or a TypeScript constant. So the Gibson MCP server has one pin
 * Dependabot does bump, `tools/hosts/package.json`, and every other site must
 * carry that same version. The hook pin in `hooks.json` runs this package's
 * own bin, so it carries this package's own version.
 *
 * When this test fails after a bump, update every site it names to the
 * version it prints. That is the whole procedure.
 */
const ROOT = new URL("../../../", import.meta.url)
const read = (path: string): Promise<string> => readFile(fileURLToPath(new URL(path, ROOT)), "utf8")

const EXACT = /^\d+\.\d+\.\d+$/

/** Every `@zeroroot-ai/<name>@<spec>` reference in one file. */
function specs(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`@zeroroot-ai/${name}@([^\\s"'\\]\`,]+)`, "g"))].map((m) => m[1]!)
}

const GIBSON_MCP_SITES = [
  "README.md",
  "hosts/cursor.md",
  "hosts/codex.md",
  "hosts/gemini.md",
  "hosts/windsurf.md",
  "packages/claude-gibson/.mcp.json",
  "packages/opencode-gibson/src/mcp-config.ts",
]

test("every install path pins the Gibson MCP server to the version tools/hosts pins", async () => {
  const tools = JSON.parse(await read("tools/hosts/package.json")) as { dependencies: Record<string, string> }
  const pin = tools.dependencies["@zeroroot-ai/gibson-mcp"]!
  assert.match(pin, EXACT, "tools/hosts/package.json pins an exact version")
  // The agent image installs the same server from tools/claude. One version everywhere.
  const image = JSON.parse(await read("tools/claude/package.json")) as { dependencies: Record<string, string> }
  assert.equal(image.dependencies["@zeroroot-ai/gibson-mcp"], pin, "tools/claude/package.json must carry the tools/hosts pin")
  for (const site of GIBSON_MCP_SITES) {
    const found = specs(await read(site), "gibson-mcp")
    assert.ok(found.length > 0, `${site}: names @zeroroot-ai/gibson-mcp with a version`)
    for (const spec of found) {
      assert.equal(spec, pin, `${site}: @zeroroot-ai/gibson-mcp@${spec} must be @${pin}, the tools/hosts pin`)
    }
  }
})

test("the hooks run this package's own bin at this package's own version", async () => {
  const pkg = JSON.parse(await read("packages/claude-gibson/package.json")) as { version: string }
  assert.match(pkg.version, EXACT)
  const found = specs(await read("packages/claude-gibson/hooks/hooks.json"), "zerocool-claude")
  assert.equal(found.length, 2, "one pin per hook")
  for (const spec of found) {
    assert.equal(spec, pkg.version, `hooks.json: @zeroroot-ai/zerocool-claude@${spec} must be @${pkg.version}`)
  }
})

test("the reader catches a floating tag, so this guard can fail", () => {
  const floating = '"args": ["--yes", "--package", "@zeroroot-ai/gibson-mcp@latest", "gibson-mcp"]'
  assert.deepEqual(specs(floating, "gibson-mcp"), ["latest"])
  assert.doesNotMatch("latest", EXACT)
  assert.doesNotMatch("^0.2.0", EXACT)
  assert.deepEqual(specs("npx --package @zeroroot-ai/gibson-mcp@0.2.1 gibson-mcp", "gibson-mcp"), ["0.2.1"])
})
