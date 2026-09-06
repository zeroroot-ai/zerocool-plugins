// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import type { TaskHarness } from "@zeroroot-ai/sdk"

/**
 * The Claude Code transcript of a job, archived to the session store and
 * restored from it (zerocool-plugins#107, glossary: Checkpoint, Resume).
 *
 * Claude Code writes a session to `$CLAUDE_CONFIG_DIR/projects/<key>/`, where
 * `<key>` is the working directory with every `/` and `.` turned into `-`
 * (measured on 2.1.257). The main transcript is `<session_id>.jsonl`, and a
 * session that spawned subagents keeps their transcripts under
 * `<session_id>/`. `--resume <session_id>` reads them back from any project
 * directory on the machine.
 *
 * A sandbox is ephemeral. When a job closes, or the member stops, the files
 * go to the session store under the job id so a relaunched member can put
 * them back and resume the same session. The store caps one blob at 8 MiB,
 * so a transcript is stored as chunks under 1 MiB behind one manifest.
 */
export const CHUNK_BYTES = 1024 * 1024 - 4096

/** `projects/<key>`: the directory Claude Code keeps a working directory's sessions in. */
export function projectKey(cwd: string): string {
  return cwd.replace(/[/.]/g, "-")
}

export function projectDir(configDir: string, cwd: string): string {
  return join(configDir, "projects", projectKey(cwd))
}

async function walk(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/**
 * Every file of one session: the transcript and its subagent transcripts.
 * Searched under the job's own project directory first, then under every
 * project directory, because `--resume` finds a session in any of them.
 */
export async function findTranscriptFiles(configDir: string, cwd: string, sessionId: string): Promise<string[]> {
  if (!sessionId) return []
  const own = projectDir(configDir, cwd)
  const inOwn = (await walk(own)).filter((f) => relative(own, f).includes(sessionId))
  if (inOwn.length > 0) return inOwn
  const root = join(configDir, "projects")
  return (await walk(root)).filter((f) => relative(root, f).includes(sessionId))
}

/** The session store, as the driver uses it. */
export interface SessionStore {
  put(key: string, data: Uint8Array): Promise<void>
  /** `undefined` when the store has nothing under the key. */
  get(key: string): Promise<Uint8Array | undefined>
}

/** The session store over the harness, under the grant the harness holds. */
export function harnessSessionStore(harness: TaskHarness): SessionStore {
  return {
    async put(key, data) {
      const res = await harness.client.putSessionContext({ context: harness.context, sessionId: key, data, ifMatch: "" })
      if (res.error) throw new Error(`PutSessionContext(${key}) refused: ${res.error.message}`)
    },
    async get(key) {
      const res = await harness.client.getSessionContext({ context: harness.context, sessionId: key })
      if (res.error) {
        if (/not found|no such|unknown/i.test(res.error.message)) return undefined
        throw new Error(`GetSessionContext(${key}) refused: ${res.error.message}`)
      }
      return res.data && res.data.byteLength > 0 ? res.data : undefined
    },
  }
}

/** What sits under the job id in the store. */
export interface TranscriptManifest {
  version: 1
  sessionId: string
  /** The working directory the session was recorded under. */
  cwd: string
  files: { path: string; bytes: number; chunks: string[] }[]
  archivedAt: number
}

export function chunkKey(jobId: string, index: number): string {
  return `${jobId}/${index}`
}

/** Split bytes into pieces the store accepts. */
export function chunk(data: Uint8Array, size = CHUNK_BYTES): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < data.byteLength; i += size) out.push(data.subarray(i, Math.min(i + size, data.byteLength)))
  return out.length > 0 ? out : [new Uint8Array(0)]
}

export interface ArchiveOptions {
  store: SessionStore
  jobId: string
  configDir: string
  cwd: string
  sessionId: string
  clock?: () => number
}

/**
 * Archive the job's transcript. Returns the manifest, or `undefined` when
 * there is nothing on disk to archive (a job that never ran a turn).
 */
export async function archiveTranscript(opts: ArchiveOptions): Promise<TranscriptManifest | undefined> {
  const files = await findTranscriptFiles(opts.configDir, opts.cwd, opts.sessionId)
  if (files.length === 0) return undefined
  const root = join(opts.configDir, "projects")
  const manifest: TranscriptManifest = { version: 1, sessionId: opts.sessionId, cwd: opts.cwd, files: [], archivedAt: (opts.clock ?? Date.now)() }
  let index = 0
  for (const file of files) {
    const data = new Uint8Array(await readFile(file))
    const keys: string[] = []
    for (const piece of chunk(data)) {
      const key = chunkKey(opts.jobId, index++)
      await opts.store.put(key, piece)
      keys.push(key)
    }
    manifest.files.push({ path: relative(root, file), bytes: data.byteLength, chunks: keys })
  }
  await opts.store.put(opts.jobId, new TextEncoder().encode(JSON.stringify(manifest)))
  return manifest
}

export interface RestoreOptions {
  store: SessionStore
  jobId: string
  configDir: string
}

/**
 * Put an archived transcript back under the config directory. Returns the
 * session id to `--resume`, or `undefined` when the store holds nothing for
 * the job. Files are written where they were, so the session's own project
 * directory is what `--resume` finds first.
 */
export async function restoreTranscript(opts: RestoreOptions): Promise<string | undefined> {
  const raw = await opts.store.get(opts.jobId)
  if (!raw) return undefined
  let manifest: TranscriptManifest
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw)) as TranscriptManifest
  } catch {
    throw new Error(`the session store holds something under ${opts.jobId} that is not a transcript manifest`)
  }
  if (manifest.version !== 1 || !manifest.sessionId) throw new Error(`transcript manifest for ${opts.jobId} is not a version this driver reads`)
  const root = join(opts.configDir, "projects")
  for (const file of manifest.files) {
    const pieces: Uint8Array[] = []
    for (const key of file.chunks) {
      const piece = await opts.store.get(key)
      if (!piece) throw new Error(`transcript chunk ${key} is missing from the session store`)
      pieces.push(piece)
    }
    const target = join(root, file.path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, Buffer.concat(pieces.map((p) => Buffer.from(p))), { mode: 0o600 })
  }
  return manifest.sessionId
}

/** True when the session's transcript is on local disk. */
export async function transcriptOnDisk(configDir: string, cwd: string, sessionId: string): Promise<boolean> {
  const files = await findTranscriptFiles(configDir, cwd, sessionId)
  for (const f of files) {
    try {
      if ((await stat(f)).size > 0) return true
    } catch {
      // gone between the walk and the stat
    }
  }
  return false
}
