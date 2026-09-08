// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import * as entry from "./index.js"

/**
 * opencode calls EVERY export of a plugin entry module as a plugin.
 *
 * opencode 1.18.27, the `Plugin.state` loader:
 *
 *   for (const value of Object.values(module)) {
 *     const fn = asPlugin(value)              // a function, or `{ server: fn }`
 *     if (!fn) throw TypeError("Plugin export is not a function")
 *     hooks.push(await fn(input, options))
 *   }
 *
 * It de-duplicates by identity, so `export const X` plus `export default X` is
 * one plugin. Anything else is not:
 *
 *   - a helper function exported here is CALLED, with `PluginInput` as its
 *     first argument, and its return value is pushed into the hook list. A
 *     helper that builds hooks registers a second copy of the plugin. One that
 *     returns anything else puts a value in the hook list that opencode then
 *     reads hook names off, which throws on the next event.
 *   - a value that is not a function fails the whole plugin at load.
 *
 * So the entry module exports the plugin and nothing else. Helpers live in
 * sibling modules, which opencode never scans.
 */

/** opencode's own rule, as it reads a plugin module. */
function loadablePlugins(mod: Record<string, unknown>): unknown[] {
  const seen = new Set<unknown>()
  const found: unknown[] = []
  for (const value of Object.values(mod)) {
    if (seen.has(value)) continue
    seen.add(value)
    const fn =
      typeof value === "function"
        ? value
        : value && typeof value === "object" && typeof (value as { server?: unknown }).server === "function"
          ? (value as { server: unknown }).server
          : undefined
    if (!fn) throw new TypeError("Plugin export is not a function")
    found.push(fn)
  }
  return found
}

test("the entry module offers opencode exactly one plugin", () => {
  assert.equal(loadablePlugins(entry as unknown as Record<string, unknown>).length, 1)
})

test("the one plugin is the sessions plugin", () => {
  assert.equal(entry.default, entry.GibsonSessionsPlugin)
  assert.equal(typeof entry.GibsonSessionsPlugin, "function")
})

// The fixtures the rule is read from. Each is a module shape this guard must
// reject, and each is a shape a helpful-looking `export` would produce.
test("a helper exported beside the plugin becomes a second plugin", () => {
  const plugin = (): void => {}
  const helper = (): void => {}
  assert.equal(loadablePlugins({ plugin, default: plugin, helper }).length, 2)
})

test("a value that is not a function fails the whole plugin at load", () => {
  assert.throws(() => loadablePlugins({ plugin: () => {}, VERSION: 1 }), /Plugin export is not a function/)
})
