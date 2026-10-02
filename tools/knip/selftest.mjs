#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * Prove the knip configuration can fail (zerocool-plugins#102).
 *
 * A guard that cannot fail is worse than none. This script takes the
 * repository's own knip.jsonc, points its root workspace at
 * tools/knip/fixture (a barrel with one unused function and one unused type),
 * and runs knip on that workspace alone. It fails unless knip exits non-zero,
 * names both unused exports, and keeps quiet about the used one.
 *
 * Run by `pnpm lint` after `pnpm knip`, so CI proves the guard looked.
 */
import { spawnSync } from "node:child_process"
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))
/** The tree had 97 source files when this floor was set. A pattern that matches fewer than this is broken. */
const MIN_COVERED_FILES = 80
const fixture = "tools/knip/fixture"

/** knip.jsonc with comments removed, so the selftest reads the same rules the lint runs. */
function readConfig() {
  const raw = readFileSync(join(root, "knip.jsonc"), "utf8")
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "")
  return JSON.parse(stripped)
}

function main() {
  const config = readConfig()
  for (const key of ["includeEntryExports", "ignoreExportsUsedInFile", "rules"]) {
    if (!(key in config)) {
      console.error(`knip selftest: knip.jsonc has no "${key}"; the selftest proves nothing without it`)
      return 1
    }
  }
  if (config.rules.exports !== "error" || config.rules.types !== "error") {
    console.error(`knip selftest: rules.exports and rules.types must be "error", got ${config.rules.exports} / ${config.rules.types}`)
    return 1
  }

  // The same options and rules, the root workspace pointed at the fixture.
  const probe = {
    ...config,
    ignore: [],
    workspaces: {
      ".": { entry: [`${fixture}/index.ts`], project: [`${fixture}/*.ts`] },
    },
  }
  const dir = mkdtempSync(join(tmpdir(), "zerocool-knip-selftest-"))
  const configPath = join(dir, "knip.selftest.json")
  writeFileSync(configPath, JSON.stringify(probe))
  try {
    const run = spawnSync(
      "pnpm",
      ["exec", "knip", "--config", configPath, "--workspace", ".", "--no-progress", "--no-config-hints", "--reporter", "json"],
      { cwd: root, encoding: "utf8" },
    )
    if (run.error) {
      console.error(`knip selftest: could not run knip: ${run.error.message}`)
      return 1
    }
    const stdout = run.stdout ?? ""
    let report
    try {
      report = JSON.parse(stdout)
    } catch {
      console.error(`knip selftest: knip printed no JSON report (exit ${run.status})\n${stdout}\n${run.stderr}`)
      return 1
    }
    const issues = Array.isArray(report?.issues) ? report.issues : []
    const names = (kind) => issues.flatMap((f) => (f[kind] ?? []).map((e) => `${f.file}:${e.name}`))
    const exportsFound = names("exports")
    const typesFound = names("types")
    const all = [...exportsFound, ...typesFound]
    console.log(`knip selftest: knip exit ${run.status}, ${exportsFound.length} unused exports, ${typesFound.length} unused types on the fixture`)
    for (const n of all) console.log(`  ${n}`)

    const failures = []
    if (run.status === 0) failures.push("knip exited 0 on a fixture with an unused export")
    if (!exportsFound.some((n) => n.endsWith("runner.ts:unusedRunner"))) failures.push("knip did not report unusedRunner through the barrel")
    if (!typesFound.some((n) => n.endsWith("runner.ts:UnusedOptions"))) failures.push("knip did not report UnusedOptions through the barrel")
    if (all.some((n) => n.endsWith(":usedHelper"))) failures.push("knip reported usedHelper, which the barrel and the runner both import")
    if (all.length !== 2) failures.push(`expected exactly 2 findings on the fixture, got ${all.length}`)
    if (failures.length > 0) {
      for (const f of failures) console.error(`knip selftest: FAIL: ${f}`)
      console.error(run.stderr)
      return 1
    }
    console.log("knip selftest: PASS, the configuration fails on an unused export")

    // The real run exits 0 in silence. Print what it covers, and refuse a
    // tree so small that a broken project pattern would pass unnoticed.
    const covered = globSync("packages/*/src/**/*.ts", { cwd: root }).filter((f) => !f.includes("/test/fixtures/"))
    console.log(`knip selftest: the repository run covers ${covered.length} TypeScript files under packages/*/src`)
    if (covered.length < MIN_COVERED_FILES) {
      console.error(`knip selftest: FAIL: only ${covered.length} files matched, below the ${MIN_COVERED_FILES} floor; a project pattern is broken`)
      return 1
    }
    return 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

process.exit(main())
