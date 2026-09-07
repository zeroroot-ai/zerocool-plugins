// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { spawn, type ChildProcess } from "node:child_process"
import { resolveBin } from "./claude-run.js"

/**
 * Subscription sign-in inside the sandbox (zerocool-plugins#109, epic
 * decision 8, the driver half of gibson#1715).
 *
 * The platform never stores a Claude subscription credential. The person signs
 * in through Anthropic's own flow, inside the sandbox, and the credential stays
 * on the sandbox's ephemeral disk under `CLAUDE_CONFIG_DIR`. The driver only
 * relays what the CLI prints and types back the code the person pasted.
 *
 * What `claude auth login` does with no TTY, measured on 2.1.257 (the spike on
 * gibson#1715):
 *
 *  1. stdout: `Opening browser to sign in…`, then
 *     `If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...`,
 *     then `Paste code here if prompted > `, and it waits on stdin.
 *  2. A wrong code prints `Invalid code. Please make sure the full code was
 *     copied.` on stderr and it keeps waiting. It does not exit.
 *  3. On success the credential lands in `$CLAUDE_CONFIG_DIR/.credentials.json`
 *     and `claude auth status --json` reports `loggedIn: true`.
 *
 * This module never reads `.credentials.json`, never copies it, and never logs
 * the URL, the code, or anything the CLI printed after the URL line.
 */

/** What `claude auth status --json` reports. Addressing only, never a token. */
export interface AuthStatus {
  loggedIn: boolean
  /** `claude.ai` for a subscription, `apiKey` for a key. Empty when unknown. */
  authMethod: string
  subscriptionType: string
  /** Unix milliseconds, `0` when the CLI reported none. */
  expiresAt: number
}

export interface SignInPrompt {
  /** The authorization URL the person opens. Relayed, never logged. */
  url: string
  /** The paste prompt the CLI printed, e.g. `Paste code here if prompted > `. */
  codePrompt: string
}

/** Where the relay goes. The daemon side is gibson#1715 (C9). */
export interface SignInRelay {
  /** The URL and the prompt reached the console. */
  reportPrompt(prompt: SignInPrompt): Promise<void>
  /** The code the person submitted was refused. They may send another. */
  reportInvalidCode(message: string): Promise<void>
  /** The login completed. Carries the expiry when the CLI reported one. */
  reportSignedIn(status: AuthStatus): Promise<void>
  /** The login failed for good: the CLI exited, or the deadline passed. */
  reportFailed(reason: string): Promise<void>
  /** The login is close to expiry and the person should sign in again. */
  reportExpiring?(daysLeft: number): Promise<void>
}

export class SignInError extends Error {}

const PROMPT_LINE = /paste code[^\n]*/i
const INVALID_LINE = /invalid code[^\n]*/i
const EXPIRY_LINE = /login expires in (\d+) days?/i

/**
 * Read the authorization URL out of one stdout line. Empty when there is none.
 *
 * The URL is the first whitespace-free run that starts with `https://` and
 * has `claude.` followed by a `/` somewhere after it, for example
 * `https://claude.com/cai/oauth/authorize?...`. A whitespace split plus
 * indexOf reads each character once. The old regular expression (three
 * overlapping non-space runs around `claude.`) was polynomial on long lines
 * (CodeQL js/polynomial-redos, #13).
 */
export function parseAuthUrl(line: string): string {
  for (const token of line.split(/\s+/)) {
    const start = token.indexOf("https://")
    if (start < 0) continue
    const url = token.slice(start)
    const host = url.indexOf("claude.", "https://".length)
    if (host >= 0 && url.indexOf("/", host + "claude.".length) >= 0) return url
  }
  return ""
}

/** Read the paste prompt out of one stdout line. Empty when there is none. */
export function parseCodePrompt(line: string): string {
  const m = PROMPT_LINE.exec(line)
  return m ? m[0]!.trim() : ""
}

/** The CLI refused the code. The message, or empty when the line is something else. */
export function parseInvalidCode(line: string): string {
  const m = INVALID_LINE.exec(line)
  return m ? m[0]!.trim() : ""
}

/** `login expires in N days` from a startup warning. `-1` when the line says nothing. */
export function parseExpiryWarning(text: string): number {
  const m = EXPIRY_LINE.exec(text)
  return m ? Number(m[1]) : -1
}

/** Parse `claude auth status --json`. A shape it does not know is "not logged in". */
export function parseAuthStatus(stdout: string): AuthStatus {
  const out: AuthStatus = { loggedIn: false, authMethod: "", subscriptionType: "", expiresAt: 0 }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(stdout.trim()) as Record<string, unknown>
  } catch {
    return out
  }
  if (!raw || typeof raw !== "object") return out
  out.loggedIn = raw.loggedIn === true
  if (typeof raw.authMethod === "string") out.authMethod = raw.authMethod
  if (typeof raw.subscriptionType === "string") out.subscriptionType = raw.subscriptionType
  const exp = raw.expiresAt
  if (typeof exp === "number" && Number.isFinite(exp)) out.expiresAt = exp
  else if (typeof exp === "string" && exp) {
    const t = Date.parse(exp)
    if (!Number.isNaN(t)) out.expiresAt = t
  }
  return out
}

/**
 * An API key beats a subscription login inside Claude Code. A member whose
 * login shape is `subscription` must therefore start with neither key set,
 * otherwise the person signs in and the key still pays.
 */
export function assertSubscriptionOnly(env: NodeJS.ProcessEnv): void {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    if (env[name]) {
      throw new SignInError(
        `${name} is set while the login shape is subscription. The key would win over the person's login, ` +
          "so this member refuses to start. Launch it with no Anthropic key, or set the login shape to api-key.",
      )
    }
  }
}

export interface SignInOptions {
  bin: string
  env: NodeJS.ProcessEnv
  cwd: string
  relay: SignInRelay
  /** Give up after this long. Default 15 minutes. */
  deadlineMs?: number
  /** `claude auth status --json` cadence while waiting. Default 2s. */
  pollMs?: number
  status?: (bin: string, env: NodeJS.ProcessEnv, cwd: string) => Promise<AuthStatus>
  log?: (line: string) => void
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">
}

/** Run `claude auth status --json` and read what it reports. */
export async function readAuthStatus(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<AuthStatus> {
  const { command, prefix } = resolveBin(bin)
  return await new Promise<AuthStatus>((resolve) => {
    const child = spawn(command, [...prefix, "auth", "status", "--json"], { cwd, env, stdio: ["ignore", "pipe", "ignore"] })
    const out: string[] = []
    child.stdout.on("data", (d: Buffer) => out.push(d.toString()))
    child.on("error", () => resolve({ loggedIn: false, authMethod: "", subscriptionType: "", expiresAt: 0 }))
    child.on("exit", () => resolve(parseAuthStatus(out.join(""))))
  })
}

/**
 * One sign-in attempt. `start` spawns the CLI and relays the URL and the
 * prompt. `submitCode` types a code the person pasted. `done` settles when the
 * login succeeded, the CLI exited, or the deadline passed.
 */
export class SignIn {
  private child: ChildProcess | undefined
  private settled = false
  private resolveDone!: (ok: boolean) => void
  private readonly log: (line: string) => void
  private readonly timers: NonNullable<SignInOptions["timers"]>
  private timer: ReturnType<typeof setTimeout> | undefined
  private poller: ReturnType<typeof setTimeout> | undefined
  readonly done: Promise<boolean>

  constructor(private readonly opts: SignInOptions) {
    this.log = opts.log ?? (() => {})
    this.timers = opts.timers ?? globalThis
    this.done = new Promise<boolean>((r) => (this.resolveDone = r))
  }

  private async finish(ok: boolean, reason: string, status?: AuthStatus): Promise<void> {
    if (this.settled) return
    this.settled = true
    if (this.timer) this.timers.clearTimeout(this.timer)
    if (this.poller) this.timers.clearTimeout(this.poller)
    this.child?.kill("SIGTERM")
    if (ok && status) await this.opts.relay.reportSignedIn(status)
    else if (!ok) await this.opts.relay.reportFailed(reason)
    this.resolveDone(ok)
  }

  /** Spawn `claude auth login` and start relaying. */
  async start(): Promise<void> {
    const { command, prefix } = resolveBin(this.opts.bin)
    const status = this.opts.status ?? readAuthStatus
    const child = spawn(command, [...prefix, "auth", "login"], {
      cwd: this.opts.cwd,
      // No browser inside a sandbox: the paste path is the path.
      env: { ...this.opts.env, BROWSER: "/bin/false", DISPLAY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child
    child.stdin?.on("error", () => {})

    let url = ""
    let prompt = ""
    let buf = ""
    const relayWhenReady = () => {
      if (!url || !prompt) return
      const p = { url, codePrompt: prompt }
      url = ""
      prompt = ""
      void this.opts.relay.reportPrompt(p).catch((e: Error) => this.log(`sign-in: relay failed: ${e.message}`))
    }
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString()
      // The prompt has no newline: it is the tail of the buffer.
      const parts = buf.split("\n")
      buf = parts.pop() ?? ""
      for (const line of parts) {
        url = parseAuthUrl(line) || url
        prompt = parseCodePrompt(line) || prompt
        relayWhenReady()
      }
      url = parseAuthUrl(buf) || url
      prompt = parseCodePrompt(buf) || prompt
      relayWhenReady()
    })
    child.stderr?.on("data", (d: Buffer) => {
      const invalid = parseInvalidCode(d.toString())
      if (invalid) void this.opts.relay.reportInvalidCode(invalid).catch((e: Error) => this.log(`sign-in: relay failed: ${e.message}`))
    })
    child.on("error", (e) => void this.finish(false, `cannot run ${this.opts.bin}: ${e.message}`))
    child.on("exit", (code) => {
      // The CLI exits after a successful paste. The status poll confirms it.
      void status(this.opts.bin, this.opts.env, this.opts.cwd).then((s) => {
        if (s.loggedIn) void this.finish(true, "", s)
        else void this.finish(false, `claude auth login exited ${code} without a login`)
      })
    })

    this.timer = this.timers.setTimeout(() => void this.finish(false, `sign-in did not complete within ${this.opts.deadlineMs ?? 900_000}ms`), this.opts.deadlineMs ?? 900_000)

    const poll = async () => {
      if (this.settled) return
      const s = await status(this.opts.bin, this.opts.env, this.opts.cwd)
      if (s.loggedIn) {
        await this.finish(true, "", s)
        return
      }
      this.poller = this.timers.setTimeout(() => void poll(), this.opts.pollMs ?? 2000)
    }
    this.poller = this.timers.setTimeout(() => void poll(), this.opts.pollMs ?? 2000)
  }

  /** Type a code the person pasted in the console. */
  submitCode(code: string): void {
    if (!this.child?.stdin || this.settled) throw new SignInError("no sign-in is waiting for a code")
    this.child.stdin.write(`${code.trim()}\n`)
  }

  /** Give up, for a Stop or a member shutdown. */
  cancel(): void {
    void this.finish(false, "sign-in cancelled")
  }
}
