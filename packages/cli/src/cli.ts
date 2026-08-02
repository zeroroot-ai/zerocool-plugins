#!/usr/bin/env node
/**
 * zerocool — a curated distribution of opencode.
 *
 * This launcher runs the bundled opencode with zerocool's default config
 * (the user's own OPENCODE_CONFIG always wins). Standalone behaviour is
 * exactly opencode: bring your own LLM key (e.g. ANTHROPIC_API_KEY). The
 * Gibson integration is delivered as an opencode plugin, not by forking
 * opencode's source (ADR-0001, plugin-first).
 */
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

function resolveOpencodeBin(): string {
  let pkgJsonPath: string | undefined
  try {
    pkgJsonPath = require.resolve("opencode-ai/package.json")
  } catch {
    let dir = dirname(require.resolve("opencode-ai"))
    while (dir !== dirname(dir)) {
      const candidate = join(dir, "package.json")
      if (existsSync(candidate) && JSON.parse(readFileSync(candidate, "utf8")).name === "opencode-ai") {
        pkgJsonPath = candidate
        break
      }
      dir = dirname(dir)
    }
  }
  if (!pkgJsonPath) throw new Error("zerocool: could not locate the opencode-ai package")
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"))
  const bin = pkg.bin
  const rel = typeof bin === "string" ? bin : bin?.opencode ?? Object.values(bin ?? {})[0]
  if (!rel) throw new Error("zerocool: opencode-ai declares no bin")
  return resolve(dirname(pkgJsonPath), rel as string)
}

const env = { ...process.env }
if (!env.OPENCODE_CONFIG) {
  const bundled = join(here, "..", "opencode.json")
  if (existsSync(bundled)) env.OPENCODE_CONFIG = bundled
}

const child = spawn(resolveOpencodeBin(), process.argv.slice(2), { stdio: "inherit", env })
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
