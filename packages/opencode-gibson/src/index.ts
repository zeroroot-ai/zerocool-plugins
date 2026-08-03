import type { Plugin } from "@opencode-ai/plugin"
import { connectGibson, startCompletionsShim, type GibsonSession, type RunningShim } from "@zerocool/sdk"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * zerocool's Gibson integration (ADR-0001, plugin-first). Standalone (no Gibson
 * key) is a no-op — zerocool behaves exactly like opencode. With a Gibson
 * bootstrap key the agent:
 *   - checks in as a Gibson component (Capability Grant + RegisterComponent + heartbeat, #4)
 *   - serves LLM via Gibson through a local OpenAI-compatible shim (Model seam, #5)
 *     that opencode's `gibson` provider points at; select model `gibson/<slot>`.
 * Tools/streaming/findings/knowledge wire on top per #6-#14.
 */
export const GibsonPlugin: Plugin = async (_ctx) => {
  const bootstrapToken = process.env.GIBSON_BOOTSTRAP_TOKEN
  const platformURL = process.env.GIBSON_PLATFORM_URL
  if (!bootstrapToken || !platformURL) return {} // standalone: zerocool === opencode

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
    console.error(`[zerocool] registered with Gibson (component_scope=${session.componentScope}); LLM via ${shim.url} — select model gibson/<slot>`)
    const stop = () => { session?.stop(); void shim?.close() }
    process.once("exit", stop)
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  } catch (e) {
    // Fail open to standalone: a coding agent must still work if the platform is unreachable.
    console.error(`[zerocool] Gibson connect failed; continuing standalone: ${(e as Error).message}`)
    void shim?.close()
    return {}
  }

  return {}
}

export default GibsonPlugin
