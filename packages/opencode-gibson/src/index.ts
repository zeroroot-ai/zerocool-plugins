// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Plugin } from "@opencode-ai/plugin"

import { createGibsonPlugin } from "./gibson-plugin.js"

/**
 * @zeroroot-ai/zerocool, the main Gibson plugin. This entry module exports the
 * plugin and nothing else, because opencode calls every export as a plugin.
 * The code is in `gibson-plugin.ts`.
 */
export const GibsonPlugin: Plugin = async () => createGibsonPlugin()

export default GibsonPlugin
