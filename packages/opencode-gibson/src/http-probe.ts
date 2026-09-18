// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"
import { decodeToolInput, type GibsonClients, type ToolInvocation } from "@zeroroot-ai/sdk"

/**
 * The http_probe tool zerocool serves to the fleet.
 *
 * A single GET, reported as structured facts. Deliberately the smallest useful
 * thing a mission node can ask an external component to do: it proves the whole
 * dispatch path — mission node → work queue → this process → result → mission
 * completion — without the result depending on anything about the target.
 *
 * SAFETY. This is a fetch, not a scanner: one request, no redirect followed,
 * no body execution, and a hard timeout. The body is measured, never returned:
 * a probe that echoes arbitrary remote content back into a mission's knowledge
 * graph is an injection surface, and the size is what the caller asked for.
 *
 * NO INTERNAL TARGET. The probe runs inside the agent container, next to the
 * instance metadata service, the Kubernetes API and every internal service.
 * A dispatch names the URL, so the host is resolved first and every address
 * it resolves to must be a public unicast address. Loopback, link-local,
 * RFC 1918, carrier-grade NAT, IPv6 unique-local and link-local, the
 * unspecified address and multicast are refused before any connection. A
 * redirect is reported as its status and never followed, so a public host
 * cannot bounce the probe inward.
 */

export interface ProbeResult {
  url: string
  status: number
  statusText: string
  server: string | null
  contentType: string | null
  bytes: number
  elapsedMs: number
}

export const HTTP_PROBE_TIMEOUT_MS = 15_000

/** One resolved address, as `dns.lookup` with `all: true` returns it. */
export interface ResolvedAddress {
  address: string
  family: number
}

/** The seams a test replaces: name resolution and the transport. */
export interface ProbeDeps {
  lookup?: (host: string) => Promise<ResolvedAddress[]>
  fetch?: typeof globalThis.fetch
}

const defaultLookup = async (host: string): Promise<ResolvedAddress[]> => dnsLookup(host, { all: true })

/** Parse dotted IPv4 into its four octets, or undefined. */
function ipv4Octets(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined
  return address.split(".").map((o) => Number(o))
}

/**
 * True when the address is not a public unicast address. Written as the
 * ranges the probe refuses, so each one is named and testable.
 */
export function isInternalAddress(address: string): boolean {
  const v4 = ipv4Octets(address)
  if (v4) {
    const [a, b] = v4 as [number, number, number, number]
    if (a === 0) return true // 0.0.0.0/8, "this network"
    if (a === 10) return true // RFC 1918
    if (a === 127) return true // loopback
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10, carrier-grade NAT
    if (a === 169 && b === 254) return true // link-local, and the cloud metadata service
    if (a === 172 && b >= 16 && b <= 31) return true // RFC 1918
    if (a === 192 && b === 168) return true // RFC 1918
    if (a >= 224) return true // multicast and reserved
    return false
  }
  if (isIP(address) !== 6) return true // not an address at all: refuse
  const groups = ipv6Groups(address)
  if (!groups) return true
  const [first] = groups as [number, number, number, number, number, number, number, number]
  const leadingZero = groups.slice(0, 5).every((g) => g === 0)
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, deprecated)
  // are judged as their IPv4 part. The URL parser writes the mapped form in
  // hex, so the last two groups are read back as four octets.
  if (leadingZero && (groups[5] === 0xffff || (groups[5] === 0 && (groups[6] !== 0 || groups[7] > 1)))) {
    const hi = groups[6]!
    const lo = groups[7]!
    return isInternalAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  if (groups.every((g) => g === 0)) return true // ::, unspecified
  if (leadingZero && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true // ::1, loopback
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7, unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10, link-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8, multicast
  return false
}

/** Expand an IPv6 address into its eight 16-bit groups, or undefined. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase()
  const zone = text.indexOf("%")
  if (zone >= 0) text = text.slice(0, zone)
  // A trailing dotted quad becomes two hex groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number]
    text = `${text.slice(0, -dotted[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return undefined
  const parts = [...head, ...Array<string>(fill).fill("0"), ...tail]
  const groups = parts.map((p) => Number.parseInt(p || "0", 16))
  return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? undefined : groups
}

/**
 * Resolve the host and refuse it when any address it maps to is internal. A
 * host that resolves to nothing is refused too: the probe has nothing to
 * check, so it does not connect.
 */
export async function assertPublicHost(hostname: string, lookup: (host: string) => Promise<ResolvedAddress[]>): Promise<void> {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  const addresses = isIP(bare) ? [{ address: bare, family: isIP(bare) }] : await lookup(bare)
  if (addresses.length === 0) throw new Error(`http_probe refuses ${hostname}: it resolves to no address`)
  for (const { address } of addresses) {
    if (isInternalAddress(address)) {
      throw new Error(`http_probe refuses ${hostname}: it resolves to ${address}, which is not a public address`)
    }
  }
}

/** Perform the probe. Exported separately from the handler so it is testable without a work item. */
export async function probe(url: string, timeoutMs = HTTP_PROBE_TIMEOUT_MS, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported scheme ${parsed.protocol} (http and https only)`)
  }
  await assertPublicHost(parsed.hostname, deps.lookup ?? defaultLookup)
  const doFetch = deps.fetch ?? globalThis.fetch

  const started = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await doFetch(parsed.toString(), { method: "GET", redirect: "manual", signal: ctl.signal })
    const body = await res.arrayBuffer()
    return {
      url: parsed.toString(),
      status: res.status,
      statusText: res.statusText,
      server: res.headers.get("server"),
      contentType: res.headers.get("content-type"),
      bytes: body.byteLength,
      elapsedMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Work handler: takes a claimed tool invocation and returns the probe result.
 *
 * `url` is required. A missing url throws rather than defaulting to something,
 * because a probe that quietly fetches a different target than the mission
 * asked for is worse than a failed node.
 *
 * `clients` is the callback-harness seam: every dispatched handler receives
 * the session's Gibson clients so it can reach LLM (`clients.component`),
 * tools, findings and knowledge (`clients.harness`) during a dispatched run.
 * The probe itself needs none of that — one request, structured facts — so
 * the parameter is optional and unused here; richer served tools consume it.
 */
export async function httpProbeHandler(invocation: ToolInvocation, _clients?: GibsonClients): Promise<ProbeResult> {
  const url = invocation.input.url
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("http_probe requires a `url` parameter")
  }
  const timeout =
    typeof invocation.input.timeout_ms === "number" ? invocation.input.timeout_ms : HTTP_PROBE_TIMEOUT_MS
  return probe(url, timeout)
}

/** Re-exported so a caller can decode a raw payload without importing the SDK directly. */
export { decodeToolInput }
