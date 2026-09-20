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
 * carry that same version.
 *
 * The hook runs this package's own bin, so it carries this package's own
 * version. That pin lives in `hooks/zerocool-claude-hook.mjs` on one
 * annotated line, and release-please bumps it with the package version
 * (release-please-config.json, extra-files). A JSON file has no line a
 * release tool can annotate, which is why the pin is not in hooks.json. This
 * guard fails when the line, the annotation or the config entry goes
 * missing. It never fails after a routine release.
 *
 * When the first test fails after a Dependabot bump, update every site it
 * names to the version it prints. That is the whole procedure.
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

const HOOK_ENTRY = "hooks/zerocool-claude-hook.mjs"
/** The one line release-please bumps. The annotation is what its generic updater looks for. */
const PIN_LINE = /^const VERSION = "([^"]+)" \/\/ x-release-please-version$/m

/** The pin on the annotated line, or nothing when the line is not there. */
export function hookPin(entry: string): string | undefined {
  return PIN_LINE.exec(entry)?.[1]
}

test("the hook entry pins this package's own version on the line release-please bumps", async () => {
  const pkg = JSON.parse(await read("packages/claude-gibson/package.json")) as { version: string }
  assert.match(pkg.version, EXACT)
  const entry = await read(`packages/claude-gibson/${HOOK_ENTRY}`)
  const pin = hookPin(entry)
  assert.ok(pin, `${HOOK_ENTRY}: one line reads const VERSION = "<version>" // x-release-please-version`)
  assert.match(pin, EXACT)
  assert.equal(pin, pkg.version, `${HOOK_ENTRY}: VERSION ${pin} must be ${pkg.version}, the package version`)
  assert.ok(entry.includes("zerocool-claude-hook"), `${HOOK_ENTRY}: runs the hook bin`)
  assert.ok(entry.includes("@zeroroot-ai/zerocool-claude@"), `${HOOK_ENTRY}: from this package`)
  assert.ok(!entry.includes("@latest"), `${HOOK_ENTRY}: never a floating tag`)
})

test("release-please bumps the hook entry: it is an extra file of the package", async () => {
  const config = JSON.parse(await read("release-please-config.json")) as { packages: Record<string, { "extra-files"?: unknown[] }> }
  const extra = config.packages["packages/claude-gibson"]?.["extra-files"] ?? []
  assert.ok(extra.includes(HOOK_ENTRY), `release-please-config.json: packages/claude-gibson extra-files must list ${HOOK_ENTRY}`)
})

test("the hooks run the entry with node, so the pin has one home", async () => {
  const hooks = JSON.parse(await read("packages/claude-gibson/hooks/hooks.json")) as { hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]> }
  const commands = Object.values(hooks.hooks).flatMap((event) => event.flatMap((entry) => entry.hooks))
  assert.equal(commands.length, 2, "one hook per event")
  for (const hook of commands) {
    assert.equal(hook.command, "node", "exec form with node runs on every platform; an npx shim does not")
    assert.deepEqual(hook.args, [`\${CLAUDE_PLUGIN_ROOT}/${HOOK_ENTRY}`])
  }
  assert.ok(!JSON.stringify(hooks).includes("@zeroroot-ai/"), "hooks.json carries no version of its own")
})

test("the reader catches a floating tag, so this guard can fail", () => {
  const floating = '"args": ["--yes", "--package", "@zeroroot-ai/gibson-mcp@latest", "gibson-mcp"]'
  assert.deepEqual(specs(floating, "gibson-mcp"), ["latest"])
  assert.doesNotMatch("latest", EXACT)
  assert.doesNotMatch("^0.2.0", EXACT)
  assert.deepEqual(specs("npx --package @zeroroot-ai/gibson-mcp@0.2.1 gibson-mcp", "gibson-mcp"), ["0.2.1"])
  assert.equal(hookPin('const VERSION = "0.6.0" // x-release-please-version'), "0.6.0")
  assert.equal(hookPin('const VERSION = "0.6.0"'), undefined, "a line release-please would not bump is not a pin")
  assert.equal(hookPin('const VERSION = "latest" // x-release-please-version'), "latest")
  assert.doesNotMatch("latest", EXACT)
})
