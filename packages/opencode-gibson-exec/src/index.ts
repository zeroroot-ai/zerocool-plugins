// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Plugin } from "@opencode-ai/plugin"

import { execPlugin } from "./plugin.js"

/**
 * `@zeroroot-ai/zerocool-exec` — the executor seam (zerocool-plugins#12).
 * The plugin itself is in `plugin.ts`; see its comment for what it does.
 *
 * THIS MODULE EXPORTS THE PLUGIN AND NOTHING ELSE. opencode calls every export
 * of a plugin entry module as a plugin, so a helper exported here would be
 * invoked with `PluginInput` and its return value pushed into the hook list.
 * `entry-exports.test.ts` holds that rule down.
 */
export const GibsonExecPlugin: Plugin = async (input) => execPlugin(input)

export default GibsonExecPlugin
