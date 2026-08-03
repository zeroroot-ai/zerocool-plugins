import type { ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  callGibsonTool,
  listGibsonPlugins,
  listGibsonTools,
  queryGibsonPlugin,
  type GibsonSession,
  type GibsonTool,
} from "@zerocool/sdk"

/**
 * Gibson tools and plugins as opencode tools (zerocool-plugins#9).
 *
 * Discovered tools are registered **individually** — one opencode tool per
 * Gibson tool, named `gibson_<tool>` — so the model sees them in its tool list
 * with their own descriptions, rather than having to know that a generic
 * dispatcher exists and what to pass it.
 *
 * ON SCHEMAS — the catalog carries no JSON Schema. `ToolDescriptorProto` only
 * names the proto message types of a tool's input and output
 * (`gibson.tool.v1.ScanRequest`), and there is no RPC that resolves those to a
 * schema. So a per-tool wrapper takes a single free-form `input` object and
 * names the expected message type in its description. Inventing a Zod schema
 * from a message type name would be a guess, and a wrong guess would reject
 * valid input before it ever reached the tool.
 *
 * A generic `gibson_call_tool` is always registered as well: discovery is
 * `Unimplemented` on the current daemon (gibson#1186), and without it there
 * would be no way to reach a tool whose name the operator already knows.
 */

/** Sanitise a Gibson tool name into an opencode tool key. */
export function toolKey(name: string): string {
  return `gibson_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`
}

/** Wrap one discovered Gibson tool as an opencode tool. */
export function wrapGibsonTool(session: GibsonSession, t: GibsonTool): ToolDefinition {
  const z = tool.schema
  const schemaNote = t.inputMessageType
    ? ` Input must match the Gibson message type ${t.inputMessageType}.`
    : ""
  return tool({
    description: `${t.description || `Gibson tool "${t.name}"`}${schemaNote} Runs through the Gibson harness (authorized and metered).`,
    args: {
      input: z
        .record(z.string(), z.any())
        .describe(`Input object for the ${t.name} tool${t.inputMessageType ? ` (${t.inputMessageType})` : ""}.`),
      timeout_ms: z.number().optional().describe("Per-call timeout in milliseconds."),
    },
    async execute(args) {
      const result = await callGibsonTool(session.clients.component, {
        name: t.name,
        input: args.input,
        ...(args.timeout_ms ? { timeoutMs: args.timeout_ms } : {}),
      })
      return formatToolResult(t.name, result)
    },
  })
}

/** The always-present dispatcher for tools the catalog did not surface. */
export function callToolTool(session: GibsonSession): ToolDefinition {
  const z = tool.schema
  return tool({
    description:
      "Invoke a Gibson tool by name through the harness. Use this when you know a " +
      "tool's name but it is not in your tool list — Gibson tool discovery is not " +
      "available on every daemon.",
    args: {
      name: z.string().describe("Registered Gibson tool name."),
      input: z.record(z.string(), z.any()).describe("Input object matching the tool's input schema."),
      timeout_ms: z.number().optional().describe("Per-call timeout in milliseconds."),
    },
    async execute(args) {
      const result = await callGibsonTool(session.clients.component, {
        name: args.name,
        input: args.input,
        ...(args.timeout_ms ? { timeoutMs: args.timeout_ms } : {}),
      })
      return formatToolResult(args.name, result)
    },
  })
}

/** List what Gibson exposes to this tenant — tools and enabled plugins. */
export function listToolsTool(session: GibsonSession): ToolDefinition {
  return tool({
    description:
      "List the Gibson tools and plugins available to this tenant, with the input " +
      "message type each tool expects.",
    args: {},
    async execute() {
      const [discovery, plugins] = await Promise.all([
        listGibsonTools(session.clients.component),
        listGibsonPlugins(session.clients.component).catch(() => []),
      ])

      const lines: string[] = []
      if (discovery.unavailable) {
        lines.push(`Tool discovery is unavailable: ${discovery.unavailable}.`)
      } else if (discovery.tools.length === 0) {
        lines.push("No Gibson tools are registered for this tenant.")
      } else {
        lines.push("Gibson tools:")
        for (const t of discovery.tools) {
          lines.push(`- ${t.name} (${t.version}) — ${t.description || "no description"}`)
          if (t.inputMessageType) lines.push(`    input: ${t.inputMessageType}`)
        }
      }

      const enabled = plugins.filter((p) => p.enabled)
      if (enabled.length > 0) {
        lines.push("", "Enabled plugins:")
        for (const p of enabled) {
          lines.push(`- ${p.name} (${p.version}) — methods: ${p.methods.join(", ") || "none"}`)
        }
      }

      return {
        title: `${discovery.tools.length} tools, ${enabled.length} plugins`,
        output: lines.join("\n"),
        metadata: { tool_count: discovery.tools.length, plugin_count: enabled.length },
      }
    },
  })
}

/** Invoke a method on an enabled Gibson plugin. */
export function queryPluginTool(session: GibsonSession): ToolDefinition {
  const z = tool.schema
  return tool({
    description:
      "Call a method on an enabled Gibson plugin through the harness. Use " +
      "gibson_list_tools first to see which plugins and methods are available.",
    args: {
      plugin: z.string().describe("Registered plugin name."),
      method: z.string().describe("Method to invoke on the plugin."),
      params: z.record(z.string(), z.any()).optional().describe("Method parameters."),
      timeout_ms: z.number().optional().describe("Per-call timeout in milliseconds."),
    },
    async execute(args) {
      const result = await queryGibsonPlugin(session.clients.component, {
        plugin: args.plugin,
        method: args.method,
        ...(args.params ? { params: args.params } : {}),
        ...(args.timeout_ms ? { timeoutMs: args.timeout_ms } : {}),
      })
      return formatToolResult(`${args.plugin}.${args.method}`, result)
    },
  })
}

/**
 * Discover the tenant's tools and build one opencode tool for each, plus the
 * always-present dispatcher, catalog and plugin tools.
 *
 * Discovery runs once at plugin load. opencode reads the `tool` hook as a
 * static object, so a tool registered later in the session would not be visible
 * to the model anyway.
 */
export async function buildGibsonTools(
  session: GibsonSession,
): Promise<{ tools: Record<string, ToolDefinition>; discovered: number; note?: string }> {
  const tools: Record<string, ToolDefinition> = {
    gibson_call_tool: callToolTool(session),
    gibson_list_tools: listToolsTool(session),
    gibson_query_plugin: queryPluginTool(session),
  }

  const discovery = await listGibsonTools(session.clients.component)
  for (const t of discovery.tools) {
    // Never let a discovered tool shadow the built-ins.
    const key = toolKey(t.name)
    if (!(key in tools)) tools[key] = wrapGibsonTool(session, t)
  }

  return {
    tools,
    discovered: discovery.tools.length,
    ...(discovery.unavailable ? { note: discovery.unavailable } : {}),
  }
}

/** Render a harness tool result, keeping an in-band tool error visible. */
function formatToolResult(name: string, result: { output: unknown; error?: { code: string; message: string; retryable: boolean } }) {
  if (result.error) {
    return {
      title: `${name} failed`,
      output: `Gibson tool ${name} failed [${result.error.code}]: ${result.error.message}${result.error.retryable ? " (retryable)" : ""}`,
      metadata: { error_code: result.error.code, retryable: result.error.retryable },
    }
  }
  const text = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)
  return { title: name, output: text ?? "(no output)" }
}
