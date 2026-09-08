// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Plugin } from "@opencode-ai/plugin"

import { sessionsPlugin } from "./plugin.js"

/**
 * `@zeroroot-ai/zerocool-sessions` — the store seam (zerocool-plugins#11).
 * The plugin itself is in `plugin.ts`; see its comment for what it does.
 *
 * THIS MODULE EXPORTS THE PLUGIN AND NOTHING ELSE, and that is a rule, not a
 * style. opencode calls EVERY export of a plugin entry module as a plugin:
 *
 *   for (const value of Object.values(module)) {
 *     const fn = asPlugin(value)
 *     if (!fn) throw TypeError("Plugin export is not a function")
 *     hooks.push(await fn(input, options))
 *   }
 *
 * (opencode 1.18.27, the `Plugin.state` loader). So a helper exported from
 * here is invoked with `PluginInput` as its first argument, and whatever it
 * returns is pushed into the hook list. A helper that returns hooks registers
 * a second copy of the plugin; one that returns anything else puts a value in
 * the hook list that opencode then reads hook names off, which throws. A
 * value that is not a function fails the whole plugin at load.
 *
 * `entry-exports.test.ts` holds that rule down.
 */
export const GibsonSessionsPlugin: Plugin = async (input) => sessionsPlugin(input)

export default GibsonSessionsPlugin
