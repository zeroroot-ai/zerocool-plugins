import type { Plugin } from "@opencode-ai/plugin"

/**
 * zerocool's Gibson integration, delivered as an opencode plugin (ADR-0001,
 * plugin-first). Standalone (no Gibson key) is a no-op — zerocool behaves
 * exactly like opencode. The integration activates when a Gibson bootstrap
 * key (GIBSON_BOOTSTRAP_TOKEN) is present.
 *
 * Behaviour lands incrementally per the tracked issues:
 *   - #2  connect-es bindings for the daemon RPCs
 *   - #3  Capability Grant Protocol client (auth)
 *   - #4  register as a Gibson component
 *   - #5/#6  LLM + tools + streaming via the Gibson harness (Model seam)
 *   - #7/#8  emit findings / read the knowledge graph
 *   - #9  Gibson tools as opencode tools
 *   - #12  execution in the setec Devbox (Executor seam)
 *   - #13  checkpoint local context to the daemon session store (Store seam)
 */
export const GibsonPlugin: Plugin = async (_ctx) => {
  const platformEnabled = Boolean(process.env.GIBSON_BOOTSTRAP_TOKEN)
  if (!platformEnabled) {
    // Standalone: no hooks. zerocool === opencode.
    return {}
  }
  // Platform hooks are registered here as the integration issues land.
  return {}
}

export default GibsonPlugin
