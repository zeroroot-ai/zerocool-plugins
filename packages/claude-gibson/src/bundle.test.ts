// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"

/**
 * The bundle is what Claude Code reads: the MCP server it spawns, the hooks
 * it runs, and the manifest it shows. These files are the product, so they
 * are asserted rather than assumed (ADR-0008).
 */
const bundle = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8")) as Record<string, unknown>

test("the plugin spawns the Gibson MCP server over stdio, and nothing of its own", async () => {
  const mcp = (await bundle(".mcp.json")) as { mcpServers: Record<string, { command: string; args: string[] }> }
  assert.deepEqual(Object.keys(mcp.mcpServers), ["gibson"], "one server, the shared one")
  const gibson = mcp.mcpServers.gibson!
  assert.equal(gibson.command, "npx")
  assert.ok(gibson.args.includes("@zeroroot-ai/gibson-mcp@latest"), "the tools come from the shared package")
  assert.ok(gibson.args.includes("gibson-mcp"))
  assert.deepEqual(gibson.args.slice(-2), ["--transport", "stdio"], "a host that spawns the server speaks stdio")
  assert.ok(!JSON.stringify(mcp).includes("zerocool-claude-mcp"), "the in-package server is gone, not deprecated")
})

test("the hooks are the two a host adapter keeps, and they run this package's hook bin", async () => {
  const hooks = (await bundle("hooks/hooks.json")) as { hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]> }
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionEnd", "SessionStart"])
  for (const event of Object.values(hooks.hooks)) {
    for (const entry of event) {
      for (const hook of entry.hooks) {
        assert.ok(hook.args.includes("zerocool-claude-hook"), "the hook bin, not a tool")
      }
    }
  }
})

test("the package ships one bin and no MCP server dependency", async () => {
  const pkg = (await bundle("package.json")) as { bin: Record<string, string>; dependencies: Record<string, string> }
  assert.deepEqual(Object.keys(pkg.bin), ["zerocool-claude-hook"])
  assert.equal(pkg.dependencies["@modelcontextprotocol/sdk"], undefined, "the server surface moved to @zeroroot-ai/gibson-mcp")
  assert.equal(pkg.dependencies.zod, undefined)
})
