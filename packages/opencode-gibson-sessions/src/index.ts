import type { Plugin } from "@opencode-ai/plugin"

/**
 * Opt-in: mirror opencode session/local-context to the trusted daemon store
 * (zerocool#13) via event hooks; restore on start. Invasive — it changes where
 * state lives — so it is a separate plugin.
 */
export const GibsonSessionsPlugin: Plugin = async (_input) => {
  // TODO(#13): on session.updated/message.updated -> push to the daemon store; restore on init.
  return {}
}
export default GibsonSessionsPlugin
