#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * Guard the hash-pinned Python requirements of the opencode agent image.
 *
 * `mcp` is below 1.30.0 in a Dependabot compile (semgrep pins mcp==1.29.0), and the
 * vulnerability gate then blocks the image on CVE-2026-115563. This guard fails
 * when the `mcp==` pin of requirements.txt is below the floor. The floors are
 * keyed by package name.
 *
 *   node tools/image-guards/check-image-pins.mjs             check the real file
 *   node tools/image-guards/check-image-pins.mjs --selftest  prove the guard and the closure filter can fail
 *
 * Run by `pnpm lint`, so the fast CI tier runs both.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "../..")
const REQUIREMENTS = join(root, "packages/opencode-gibson/image/requirements.txt")
const CLOSURE = join(root, "packages/opencode-gibson/image/check-closure.py")

/** The lowest version of each package that clears a known CVE. */
const FLOORS = { mcp: "1.30.0" } // CVE-2026-115563

/** `1.30.0rc1` is the numbers 1.30.0 and a pre-release flag. A pre-release is below its release. */
const parts = (v) => {
  const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(v)
  return { nums: (m?.[1] ?? "0").split(".").map((n) => Number.parseInt(n, 10)), pre: /^[-_.]?(a|b|c|rc|alpha|beta|pre|preview|dev)/i.test(m?.[2] ?? "") }
}
function below(version, floor) {
  const a = parts(version)
  const b = parts(floor)
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0)
    if (d !== 0) return d < 0
  }
  return a.pre && !b.pre
}

/** The version that requirements.txt pins for `name`, or undefined. */
export function pinOf(text, name) {
  return new RegExp(`^${name}==(\\S+?)(?:\\s|\\\\|$)`, "m").exec(text)?.[1]
}

/** The problems of one requirements file, one string for each. */
export function check(text) {
  const out = []
  for (const [name, floor] of Object.entries(FLOORS)) {
    const v = pinOf(text, name)
    if (v === undefined) out.push(`${name} has no == pin in the requirements file`)
    else if (below(v, floor)) out.push(`${name}==${v} is below ${floor}`)
  }
  return out
}

function selftest() {
  const read = (f) => readFileSync(join(here, "fixture", f), "utf8")
  let failed = 0
  const expect = (label, ok) => {
    if (!ok) {
      console.error(`image guard selftest: ${label}`)
      failed++
    }
  }
  expect("an mcp pin below 1.30.0 must fail the guard", check(read("mcp-too-old.txt")).length === 1)
  expect("an mcp pin of 1.30.0 must pass the guard", check(read("mcp-ok.txt")).length === 0)
  expect("a pre-release of the floor is below the floor and must fail the guard", check(read("mcp-prerelease.txt")).length === 1)
  expect("a file with no mcp pin must fail the guard", check("semgrep==1.0.0\n").length === 1)
  const closure = (f) => spawnSync("python3", [CLOSURE, "--from-file", join(here, "fixture", f)], { encoding: "utf8" }).status
  expect("the allowed semgrep to mcp conflict alone must pass the closure check", closure("closure-allowed.txt") === 0)
  expect("a missing requirement must fail the closure check", closure("closure-missing.txt") === 1)
  expect("another package that requires mcp==1.29.0 must fail the closure check", closure("closure-other-package.txt") === 1)
  // The line that pip check prints for the real pin must be accepted. A hand bump of the pin (1.31) then
  // fails here, in the pull request, and not on main when the image build runs the closure check.
  const pin = pinOf(readFileSync(REQUIREMENTS, "utf8"), "mcp")
  const dir = mkdtempSync(join(tmpdir(), "image-guards-"))
  const real = join(dir, "real.txt")
  writeFileSync(real, `semgrep 1.182.1 has requirement mcp==1.29.0, but you have mcp ${pin}.\n`)
  expect(`the closure filter must accept the pip check line for the real pin mcp ${pin}; update ALLOWED in check-closure.py with the pin`, spawnSync("python3", [CLOSURE, "--from-file", real], { encoding: "utf8" }).status === 0)
  rmSync(dir, { recursive: true, force: true })
  expect("another conflict must fail the closure check", closure("closure-other-conflict.txt") === 1)
  expect("another mcp pin of semgrep must fail the closure check", closure("closure-other-mcp-pin.txt") === 1)
  return failed === 0 ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--selftest")) process.exit(selftest())
  const problems = check(readFileSync(REQUIREMENTS, "utf8"))
  for (const p of problems) console.error(`image guard: ${p}. Raise the pin, with the hashes from PyPI.`)
  process.exit(problems.length === 0 ? 0 : 1)
}
