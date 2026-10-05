// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import type { Pipeline } from "./gitlab.js"
import { SCAN_CATALOG_MISSION, scanCatalogParams } from "./watch.js"

/**
 * The parameter names of the Scan mission agree with gibson
 * (zerocool-plugins#115, gibson#685, ADR-0118).
 *
 * The daemon refuses a parameter that the mission does not declare, and a
 * request that omits one. The names in `watch.ts` are thus a contract with a
 * different repo. gibson publishes the names of each checked-in mission as
 * `internal/platform/missioncatalog/mission-params.json`.
 *
 * `contracts/gibson-mission-params.json` is a copy of that file, byte for
 * byte. `contracts/gibson-pin.json` states the gibson commit that the copy
 * comes from. The test reads the copy and never fetches gibson. To move the
 * pin, copy the file from the new gibson commit and change the pin in the
 * same pull request.
 */

interface PublishedMissions {
  missions: Record<string, { version: string; params: string[] }>
}

const read = (name: string): string => readFileSync(new URL(`../contracts/${name}`, import.meta.url), "utf8")

/** The names that one side has and the other side does not. */
function paramDrift(sent: string[], published: string[]): { unknown: string[]; missing: string[] } {
  return {
    unknown: sent.filter((n) => !published.includes(n)).sort(),
    missing: published.filter((n) => !sent.includes(n)).sort(),
  }
}

const pipeline: Pipeline = {
  id: 41,
  status: "success",
  ref: "main",
  sha: "cafebabe",
  webUrl: "https://gitlab.com/examplebank/customer-portal/-/pipelines/41",
}

const sent = (): string[] =>
  Object.keys(
    scanCatalogParams({
      application: "customer-portal",
      pipeline,
      repositoryUrl: "https://gitlab.com/examplebank/customer-portal.git",
      imageRef: "registry.gitlab.com/examplebank/customer-portal@sha256:abc",
    }),
  )

const published = (): string[] => {
  const doc = JSON.parse(read("gibson-mission-params.json")) as PublishedMissions
  const mission = doc.missions[SCAN_CATALOG_MISSION]
  assert.ok(mission, `the published file lists no mission named ${SCAN_CATALOG_MISSION}`)
  assert.ok(mission.params.length > 0, "the published file lists no parameter for the scan mission")
  return mission.params
}

test("the scan parameters that watch.ts sends are the ones that gibson publishes", () => {
  assert.deepEqual(paramDrift(sent(), published()), { unknown: [], missing: [] })
})

test("the pin names the gibson commit of the copy", () => {
  const pin = JSON.parse(read("gibson-pin.json")) as { repo: string; ref: string; path: string }
  assert.equal(pin.repo, "zeroroot-ai/gibson")
  assert.equal(pin.path, "internal/platform/missioncatalog/mission-params.json")
  assert.match(pin.ref, /^[0-9a-f]{40}$/, "the pin is a full commit hash, which cannot move")
})

// The failing fixtures. Each one must report drift, or the check cannot fail.
test("a parameter that gibson renamed is reported", () => {
  const renamed = published().map((n) => (n === "imageRef" ? "imageDigest" : n))
  assert.deepEqual(paramDrift(sent(), renamed), { unknown: ["imageRef"], missing: ["imageDigest"] })
})

test("a parameter that watch.ts adds is reported", () => {
  assert.deepEqual(paramDrift([...sent(), "host"], published()), { unknown: ["host"], missing: [] })
})

test("a parameter that watch.ts drops is reported", () => {
  assert.deepEqual(paramDrift(sent().filter((n) => n !== "commit"), published()), { unknown: [], missing: ["commit"] })
})
