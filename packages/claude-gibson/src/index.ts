// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// @zeroroot-ai/zerocool-claude: the Claude Code host adapter (ADR-0008).
//
// The tools are not here. They come from the Gibson MCP server, which the
// bundle's `.mcp.json` names. This package is the bundle around it: the
// plugin manifest, the marketplace entry, and two hooks. The only bin is
// the hook.
export * from "./state.js"
export { runHook, type HookInput } from "./hook-run.js"
