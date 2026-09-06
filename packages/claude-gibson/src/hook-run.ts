// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { readFile } from "node:fs/promises"
import { openTaskHarness } from "@zeroroot-ai/sdk"
import { readAmbient, readLive, stateDir } from "./state.js"

/**
 * The hook bin. Claude Code runs it as a separate process per event, with the
 * event on stdin. It never talks to the MCP server. It reads what the server
 * handed off through the state directory (state.ts) and fails open: a missing
 * file means no output, and no output blocks nothing.
 *
 *  - SessionStart: inject the ambient knowledge block as additionalContext.
 *  - SessionEnd: checkpoint the transcript to the daemon session store under
 *    the live mission's task grant (zerocool-plugins#13, the session seam).
 */
export interface HookInput {
  session_id?: string
  hook_event_name?: string
  cwd?: string
  transcript_path?: string
  reason?: string
}

/** The session store caps a blob at 8 MiB (gibson callback_session_context.go). */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024

export async function runHook(input: HookInput, env: NodeJS.ProcessEnv, deps = { readFile }): Promise<string> {
  const cwd = input.cwd ?? process.cwd()
  const dir = stateDir(env)
  switch (input.hook_event_name) {
    case "SessionStart": {
      const block = await readAmbient(dir, cwd)
      if (!block) return ""
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block } })
    }
    case "SessionEnd": {
      const live = await readLive(dir, cwd)
      if (!live || !input.transcript_path || !input.session_id) return ""
      let data: Buffer
      try {
        data = await deps.readFile(input.transcript_path)
      } catch {
        return ""
      }
      if (data.byteLength > MAX_TRANSCRIPT_BYTES) data = data.subarray(data.byteLength - MAX_TRANSCRIPT_BYTES)
      const harness = openTaskHarness({ endpoint: live.endpoint, token: live.token, insecure: live.insecure, renew: false })
      try {
        const res = await harness.client.putSessionContext({
          context: harness.context,
          sessionId: input.session_id,
          data: new Uint8Array(data),
          ifMatch: "",
        })
        if (res.error) return JSON.stringify({ systemMessage: `zerocool: session checkpoint refused: ${res.error.message}` })
      } catch (e) {
        return JSON.stringify({ systemMessage: `zerocool: session checkpoint failed: ${(e as Error).message}` })
      } finally {
        harness.stop()
      }
      return ""
    }
    default:
      return ""
  }
}
