import type { Plugin } from "@opencode-ai/plugin"
import { connectGibson, startCompletionsShim, type GibsonSession, type RunningShim } from "@zerocool/sdk"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * @zerocool/opencode-gibson — the main Gibson plugin.
 *
 * Standalone (no Gibson key) is a no-op: opencode is unchanged. With a Gibson
 * bootstrap key it:
 *   - checks in as a Gibson component (Capability Grant + RegisterComponent + heartbeat),
 *   - starts a local OpenAI-compatible shim over the harness, and
 *   - **auto-registers a zero-config `gibson` provider** via the `config` hook, so the
 *     user just selects a `gibson/<slot>` model — no manual opencode.json edits.
 *
 * Findings, knowledge, Gibson tools, delegate/missions land on top (#7-#11).
 */
export const GibsonPlugin: Plugin = async () => {
  const bootstrapToken = process.env.GIBSON_BOOTSTRAP_TOKEN
  const platformURL = process.env.GIBSON_PLATFORM_URL
  if (!bootstrapToken || !platformURL) return {} // standalone: opencode unchanged

  let session: GibsonSession | undefined
  let shim: RunningShim | undefined
  try {
    session = await connectGibson({
      platformURL,
      daemonURL: process.env.GIBSON_DAEMON_URL,
      bootstrapToken,
      hostKeyPath: process.env.GIBSON_HOST_KEY_PATH ?? join(homedir(), ".zerocool", "host.key"),
      agentName: "zerocool",
      agentMode: process.env.GIBSON_AGENT_MODE ?? "autonomous",
      agent: { name: "zerocool", version: "0.0.0", capabilities: ["code"] },
    })
    shim = await startCompletionsShim({
      component: session.clients.component,
      port: Number(process.env.GIBSON_SHIM_PORT ?? 8787),
    })
    console.error(
      `[zerocool] Gibson connected (component_scope=${session.componentScope}); ` +
        `provider "gibson" auto-configured at ${shim.url} — select a gibson/<slot> model`,
    )
  } catch (e) {
    // Fail open to standalone: a coding agent must still work if the platform is unreachable.
    console.error(`[zerocool] Gibson connect failed; continuing standalone: ${(e as Error).message}`)
    await shim?.close()
    return {}
  }

  const shimUrl = shim.url

  return {
    // Zero-config LLM: inject the Gibson provider at config-load time (#6).
    config: async (config) => {
      const cfg = config as unknown as { provider?: Record<string, unknown> }
      cfg.provider = cfg.provider ?? {}
      if (!cfg.provider.gibson) {
        cfg.provider.gibson = {
          npm: "@ai-sdk/openai-compatible",
          name: "Gibson",
          options: { baseURL: shimUrl, apiKey: "gibson" },
        }
      }
    },
    dispose: async () => {
      session?.stop()
      await shim?.close()
    },
  }
}

export default GibsonPlugin
