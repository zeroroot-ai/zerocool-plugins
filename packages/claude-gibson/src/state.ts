// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"

/**
 * The handoff from the Gibson MCP server to this plugin's hooks.
 *
 * A hook runs as its own process and cannot reach the server's session, so
 * the server writes one small file per working directory in `~/.zerocool/`:
 * the ambient knowledge block for SessionStart, and the live-mission
 * coordinates for SessionEnd (ADR-0007's consequence, now served by the
 * server, ADR-0008).
 *
 * This file is the read half of that format, kept here because a hook must
 * not depend on the server package: the format is the contract, not the
 * import. It matches `@zeroroot-ai/gibson-mcp`'s `state.ts` exactly, and the
 * key is a hash of the working directory.
 */
export interface LiveState {
  missionId: string
  workId: string
  endpoint: string
  token: string
  insecure: boolean
  /** Unix ms. */
  writtenAt: number
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZEROCOOL_STATE_DIR ?? join(homedir(), ".zerocool")
}

export function keyFor(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16)
}

/** The block SessionStart injects. Empty when the server wrote none. */
export async function readAmbient(dir: string, cwd: string): Promise<string> {
  try {
    return await readFile(join(dir, `ambient-${keyFor(cwd)}.md`), "utf8")
  } catch {
    return ""
  }
}

/** The live mission SessionEnd checkpoints under. Undefined when there is none. */
export async function readLive(dir: string, cwd: string): Promise<LiveState | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, `live-${keyFor(cwd)}.json`), "utf8")) as LiveState
  } catch {
    return undefined
  }
}
