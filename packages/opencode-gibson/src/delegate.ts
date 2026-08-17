import type { ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  cancelMission,
  createMission,
  delegateToAgent,
  getMissionResults,
  getMissionStatus,
  isSeamUnavailable,
  listAgents,
  newTask,
  runMission,
  waitMission,
  type GibsonSession,
} from "@zeroroot-ai/sdk"

/**
 * Delegation and missions — the factory's dispatch and recursion
 * (zerocool-plugins#10).
 *
 * Rules-of-engagement, authz and budget denials come back as daemon errors.
 * They are surfaced verbatim to the model rather than retried: a denial is a
 * policy decision, and an agent that retries a denied delegation is just
 * burning budget against a wall.
 *
 * Every RPC here needs the daemon's `agentDelegator` / `missionMgr` seams,
 * which are not wired (gibson#1186). Each tool reports that state plainly
 * instead of surfacing a bare "unimplemented" to the model.
 */

const UNWIRED =
  "This daemon has no agent delegation or mission management wired (gibson#1186). " +
  "Complete the work directly instead."

export function listAgentsTool(session: GibsonSession): ToolDefinition {
  return tool({
    description:
      "List the Gibson agents in this tenant that work can be delegated to, with " +
      "their capabilities and the target types they handle.",
    args: {},
    async execute() {
      const { agents, unavailable } = await listAgents(session.clients.component)
      if (unavailable) return { title: "delegation unavailable", output: UNWIRED }
      if (agents.length === 0) {
        return { title: "no agents", output: "No agents are registered for this tenant." }
      }
      const lines = agents.map((a) => {
        const caps = a.capabilities.length > 0 ? ` — capabilities: ${a.capabilities.join(", ")}` : ""
        const targets = a.targetTypes.length > 0 ? ` — targets: ${a.targetTypes.join(", ")}` : ""
        return `- ${a.name} (${a.version}) ${a.description}${caps}${targets}`
      })
      return {
        title: `${agents.length} agent${agents.length === 1 ? "" : "s"}`,
        output: lines.join("\n"),
        metadata: { agent_count: agents.length },
      }
    },
  })
}

export function delegateTool(session: GibsonSession): ToolDefinition {
  const z = tool.schema
  return tool({
    description:
      "Delegate a sub-task to another Gibson agent and wait for its result. Use " +
      "gibson_list_agents first to pick an agent whose capabilities match the task.",
    args: {
      agent: z.string().describe("Name of the agent to delegate to."),
      goal: z.string().describe("What the delegate should accomplish."),
      context: z
        .record(z.string(), z.any())
        .optional()
        .describe("Target details, prior findings, or other context the delegate needs."),
      max_turns: z.number().optional().describe("Cap on the delegate's LLM turns."),
      allowed_tools: z.array(z.string()).optional().describe("Restrict the delegate to these tools."),
    },
    async execute(args) {
      const constraints = {
        ...(args.max_turns ? { MaxTurns: args.max_turns } : {}),
        ...(args.allowed_tools ? { AllowedTools: args.allowed_tools } : {}),
      }
      const task = newTask(args.goal, {
        ...(args.context ? { Context: args.context } : {}),
        ...(Object.keys(constraints).length > 0 ? { Constraints: constraints } : {}),
      })

      try {
        const result = await delegateToAgent(session.clients.component, args.agent, task)
        const output =
          typeof result.Output === "string" ? result.Output : JSON.stringify(result.Output, null, 2)
        const findings =
          result.Findings && result.Findings.length > 0
            ? `\n\nFindings recorded: ${result.Findings.join(", ")}`
            : ""
        const failure = result.error?.message ? `\n\nError: ${result.error.message}` : ""
        return {
          title: `${args.agent}: ${result.Status}`,
          output: `${output ?? "(no output)"}${findings}${failure}`,
          metadata: { status: result.Status, finding_ids: result.Findings ?? [] },
        }
      } catch (e) {
        if (isSeamUnavailable(e)) return { title: "delegation unavailable", output: UNWIRED }
        // Authz / RoE / budget denials land here. Show the daemon's reason.
        return {
          title: `${args.agent}: denied`,
          output: `Delegation to ${args.agent} was refused: ${(e as Error).message}`,
        }
      }
    },
  })
}

export function createMissionTool(session: GibsonSession): ToolDefinition {
  const z = tool.schema
  return tool({
    description:
      "Create a Gibson mission from a mission definition, bound to a target. The " +
      "mission is not started — call gibson_run_mission to queue it.",
    args: {
      definition: z.record(z.string(), z.any()).describe("Mission definition object."),
      target_id: z.string().describe("Identifier of the target the mission runs against."),
      opts: z.record(z.string(), z.any()).optional().describe("Optional mission creation options."),
    },
    async execute(args) {
      try {
        const info = await createMission(
          session.clients.component,
          args.definition,
          args.target_id,
          args.opts,
        )
        const id = (info.id ?? info.mission_id ?? info.missionId) as string | undefined
        return {
          title: id ? `mission ${id}` : "mission created",
          output: JSON.stringify(info, null, 2),
          ...(id ? { metadata: { mission_id: id } } : {}),
        }
      } catch (e) {
        if (isSeamUnavailable(e)) return { title: "missions unavailable", output: UNWIRED }
        throw e
      }
    },
  })
}

export function runMissionTool(session: GibsonSession): ToolDefinition {
  const z = tool.schema
  return tool({
    description: "Queue a created Gibson mission for execution. Returns as soon as it is queued.",
    args: { mission_id: z.string().describe("Mission to run.") },
    async execute(args) {
      try {
        await runMission(session.clients.component, args.mission_id)
        return { title: "queued", output: `Mission ${args.mission_id} is queued for execution.` }
      } catch (e) {
        if (isSeamUnavailable(e)) return { title: "missions unavailable", output: UNWIRED }
        throw e
      }
    },
  })
}

export function missionStatusTool(session: GibsonSession): ToolDefinition {
  const z = tool.schema
  return tool({
    description:
      "Check a Gibson mission's status, or block until it finishes. Use wait=true " +
      "only when you intend to stop and wait for the result.",
    args: {
      mission_id: z.string().describe("Mission to inspect."),
      wait: z.boolean().optional().describe("Block until the mission reaches a terminal state."),
      timeout_ms: z
        .number()
        .optional()
        .describe("How long to block when wait is true. Defaults to 5 minutes."),
    },
    async execute(args) {
      try {
        const state = args.wait
          ? await waitMission(session.clients.component, args.mission_id, args.timeout_ms ?? 300_000)
          : await getMissionStatus(session.clients.component, args.mission_id)
        return {
          title: `mission ${args.mission_id}`,
          output: JSON.stringify(state, null, 2),
        }
      } catch (e) {
        if (isSeamUnavailable(e)) return { title: "missions unavailable", output: UNWIRED }
        throw e
      }
    },
  })
}

export function missionResultsTool(session: GibsonSession): ToolDefinition {
  const z = tool.schema
  return tool({
    description: "Read the final results of a completed Gibson mission.",
    args: { mission_id: z.string().describe("Mission whose results to read.") },
    async execute(args) {
      try {
        const results = await getMissionResults(session.clients.component, args.mission_id)
        return { title: `results ${args.mission_id}`, output: JSON.stringify(results, null, 2) }
      } catch (e) {
        if (isSeamUnavailable(e)) return { title: "missions unavailable", output: UNWIRED }
        throw e
      }
    },
  })
}

export function cancelMissionTool(session: GibsonSession): ToolDefinition {
  const z = tool.schema
  return tool({
    description: "Request cancellation of a running Gibson mission.",
    args: { mission_id: z.string().describe("Mission to cancel.") },
    async execute(args) {
      try {
        await cancelMission(session.clients.component, args.mission_id)
        return { title: "cancelled", output: `Cancellation requested for mission ${args.mission_id}.` }
      } catch (e) {
        if (isSeamUnavailable(e)) return { title: "missions unavailable", output: UNWIRED }
        throw e
      }
    },
  })
}

/** Every delegation and mission tool, keyed for the opencode `tool` hook. */
export function delegationTools(session: GibsonSession): Record<string, ToolDefinition> {
  return {
    gibson_list_agents: listAgentsTool(session),
    gibson_delegate: delegateTool(session),
    gibson_create_mission: createMissionTool(session),
    gibson_run_mission: runMissionTool(session),
    gibson_mission_status: missionStatusTool(session),
    gibson_mission_results: missionResultsTool(session),
    gibson_cancel_mission: cancelMissionTool(session),
  }
}
