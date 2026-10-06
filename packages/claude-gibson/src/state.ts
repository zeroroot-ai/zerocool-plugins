// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"

/**
 * The handoff from the Gibson MCP server to this plugin's hooks.
 *
 * A hook runs as its own process and cannot reach the server's session, so
 * the server writes one small file per working directory in `~/.zerocool/`:
 * the ambient knowledge block for SessionStart, and the live-mission
 * coordinates for SessionEnd (ADR-0157's consequence, now served by the
 * server, ADR-0158).
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

/** A live state file that passed the checks, or the reason it did not. */
export type LiveRead = { state: LiveState } | { refused: string }

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]", "::1"]

/**
 * The host of an endpoint, which is `host:port` or an `https://` URL. Empty
 * when the endpoint has another shape, for example an `http://` URL.
 */
export function endpointHost(endpoint: string): string {
  if (endpoint.includes("://")) {
    let u: URL
    try {
      u = new URL(endpoint)
    } catch {
      return ""
    }
    return u.protocol === "https:" ? u.hostname : ""
  }
  // host:port. The port is read from the text: URL drops a default port.
  if (!/^[^/?#@\s]+:\d{1,5}$/.test(endpoint)) return ""
  try {
    return new URL(`https://${endpoint}`).hostname
  } catch {
    return ""
  }
}

/**
 * Why the hook must not upload a transcript under this state, or "" when it
 * may. The hook sends the whole session transcript to `endpoint` with
 * `token`, so the file must be the server's own: owned by this user, readable
 * by nobody else, and naming a TLS endpoint. TLS verification may be off only
 * for a loopback endpoint.
 */
export function liveRefusal(live: LiveState, file: { uid: number; mode: number }, uid: number | undefined): string {
  if (uid !== undefined && file.uid !== uid) return "the live state file is owned by another user"
  if ((file.mode & 0o077) !== 0) return "the live state file is readable or writable by other users; its mode must be 0600"
  if (typeof live.endpoint !== "string" || typeof live.token !== "string" || typeof live.insecure !== "boolean") {
    return "the live state file has the wrong shape"
  }
  const host = endpointHost(live.endpoint)
  if (!host) return `the endpoint ${JSON.stringify(live.endpoint)} is not host:port or an https URL`
  if (live.insecure && !LOOPBACK_HOSTS.includes(host)) return `TLS verification is off for the endpoint ${host}, which is not loopback`
  return ""
}

/**
 * The live mission SessionEnd checkpoints under. Undefined when there is none
 * or the file does not parse. A file that parses but fails liveRefusal comes
 * back as `refused`, so the hook can say why it uploaded nothing.
 */
export async function readLive(dir: string, cwd: string, uid: number | undefined = process.getuid?.()): Promise<LiveRead | undefined> {
  const path = join(dir, `live-${keyFor(cwd)}.json`)
  let live: LiveState
  let file: { uid: number; mode: number }
  try {
    file = await stat(path)
    live = JSON.parse(await readFile(path, "utf8")) as LiveState
  } catch {
    return undefined
  }
  if (typeof live !== "object" || live === null) return undefined
  const refused = liveRefusal(live, file, uid)
  return refused ? { refused } : { state: live }
}
