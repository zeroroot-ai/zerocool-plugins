import { decodeToolInput, type GibsonClients, type ToolInvocation } from "@zeroroot-ai/sdk"

/**
 * The http_probe tool zerocool serves to the fleet.
 *
 * A single GET, reported as structured facts. Deliberately the smallest useful
 * thing a mission node can ask an external component to do: it proves the whole
 * dispatch path — mission node → work queue → this process → result → mission
 * completion — without the result depending on anything about the target.
 *
 * SAFETY. This is a fetch, not a scanner: one request, no redirect chasing
 * beyond what fetch does by default, no body execution, and a hard timeout. The
 * body is measured, never returned — a probe that echoes arbitrary remote
 * content back into a mission's knowledge graph is an injection surface, and
 * the size is what the caller actually asked for.
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

/** Perform the probe. Exported separately from the handler so it is testable without a work item. */
export async function probe(url: string, timeoutMs = HTTP_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported scheme ${parsed.protocol} (http and https only)`)
  }

  const started = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(parsed.toString(), { method: "GET", signal: ctl.signal })
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
