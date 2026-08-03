import type { Plugin } from "@opencode-ai/plugin"

/**
 * Opt-in: route execution into the setec Devbox (zerocool#12). Invasive — it
 * changes where code runs — so it is a separate plugin. Uses opencode's
 * experimental_workspace to register a "gibson-devbox" workspace whose target()
 * is a remote endpoint at the Devbox. Requires the Devbox to speak opencode's
 * remote-workspace protocol (platform-side; see gibson#1183 re-scope).
 */
export const GibsonExecPlugin: Plugin = async (_input) => {
  // TODO(#12): _input.experimental_workspace.register("gibson-devbox", devboxAdapter)
  return {}
}
export default GibsonExecPlugin
