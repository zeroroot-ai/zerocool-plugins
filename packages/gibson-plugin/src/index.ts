import type { Plugin } from "@opencode-ai/plugin"
import { connectGibson, type GibsonSession } from "@zerocool/gibson-client"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * zerocool's Gibson integration (ADR-0001, plugin-first). Standalone (no Gibson
 * key) is a no-op — zerocool behaves exactly like opencode. With a Gibson
 * bootstrap key it checks in as a Gibson component (Capability Grant Protocol +
 * RegisterComponent + heartbeat, zerocool#4). LLM/tools/findings/knowledge wire
 * on top per #5-#14.
 */
export const GibsonPlugin: Plugin = async (_ctx) => {
  const bootstrapToken = process.env.GIBSON_BOOTSTRAP_TOKEN
  const platformURL = process.env.GIBSON_PLATFORM_URL
  if (!bootstrapToken || !platformURL) return {} // standalone: zerocool === opencode

  let session: GibsonSession | undefined
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
    console.error(`[zerocool] registered with Gibson (component_scope=${session.componentScope})`)
    const stop = () => session?.stop()
    process.once("exit", stop)
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  } catch (e) {
    // Fail open to standalone: a coding agent must still work if the platform is unreachable.
    console.error(`[zerocool] Gibson connect failed; continuing standalone: ${(e as Error).message}`)
    return {}
  }

  return {}
}

export default GibsonPlugin
