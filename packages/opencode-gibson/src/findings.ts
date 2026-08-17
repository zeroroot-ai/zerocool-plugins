import type { ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  newFinding,
  submitFinding,
  type Finding,
  type GibsonSession,
  type Severity,
} from "@zeroroot-ai/sdk"
import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * Findings — emit what the agent discovers into the tenant World
 * (zerocool-plugins#7).
 *
 * One code path, two backends. With a Gibson session a finding goes to the
 * tenant graph through `ComponentService.SubmitFinding` under the agent's
 * COMPONENT identity; standalone it is appended to a local JSONL log. The tool
 * the model sees is identical either way, so a prompt that works standalone
 * works on the platform.
 *
 * The agent decides what is a finding. Nothing here invents findings from file
 * edits or message traffic: a `file.edited` event is not a security finding, and
 * auto-emitting one would fill the tenant graph with noise that a human then has
 * to triage. The `event` hook only tracks session context used to stamp findings
 * with provenance.
 */

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const

export interface FindingsBackend {
  /** Submit a finding; returns the identifier it was recorded under. */
  submit(f: Finding): Promise<string>
  /** Where findings go, for the tool's result message. */
  describe(): string
}

/** Platform backend — findings land in the tenant knowledge graph. */
export function gibsonFindingsBackend(session: GibsonSession): FindingsBackend {
  return {
    submit: (f) => submitFinding(session.clients.component, f),
    describe: () => "the tenant Gibson graph",
  }
}

/**
 * Standalone backend — findings are appended as JSONL. The same Finding shape is
 * written, so a local log can be replayed into Gibson later.
 */
export function localFindingsBackend(path: string): FindingsBackend {
  return {
    submit: async (f) => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${JSON.stringify(f)}\n`, "utf8")
      return f.id
    },
    describe: () => path,
  }
}

/** Provenance stamped onto every finding this session emits. */
export interface SessionContext {
  /** opencode session ID, recorded as the finding's mission correlation. */
  sessionID?: string
}

/**
 * Build the `submit_finding` tool.
 *
 * `agent_name` is fixed to "zerocool" rather than exposed as an argument — a
 * model must not be able to attribute its findings to another agent.
 */
export function submitFindingTool(
  backend: FindingsBackend,
  context: SessionContext,
): ToolDefinition {
  const z = tool.schema
  return tool({
    description:
      "Record a security finding in the Gibson knowledge graph. Use this when you " +
      "discover a real vulnerability, misconfiguration or notable security fact about " +
      "the target or codebase — not for progress updates or general observations.",
    args: {
      title: z.string().describe("One-line summary of the finding."),
      description: z.string().describe("What the issue is, where it is, and why it matters."),
      category: z
        .string()
        .describe('Type of issue, e.g. "injection", "auth", "secrets-exposure", "misconfiguration".'),
      severity: z.enum(SEVERITIES).describe("Impact level of the finding."),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("How certain you are, from 0 to 1. Defaults to 1."),
      evidence: z
        .string()
        .optional()
        .describe("Supporting evidence — a code excerpt, request/response, or log line."),
      remediation: z.string().optional().describe("How to fix or mitigate the issue."),
      target_id: z.string().optional().describe("Identifier of the affected target or component."),
      tags: z.array(z.string()).optional().describe("Labels for filtering."),
    },
    async execute(args, ctx) {
      const finding = newFinding({
        title: args.title,
        description: args.description,
        category: args.category,
        severity: args.severity as Severity,
        confidence: args.confidence,
        missionID: context.sessionID ?? ctx.sessionID,
        agentName: "zerocool",
        ...(args.remediation ? { remediation: args.remediation } : {}),
        ...(args.target_id ? { targetID: args.target_id } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
        ...(args.evidence
          ? {
              evidence: [
                {
                  type: "text",
                  title: "evidence",
                  content: args.evidence,
                  timestamp: new Date().toISOString(),
                },
              ],
            }
          : {}),
      })

      const id = await backend.submit(finding)
      return {
        title: `${args.severity}: ${args.title}`,
        output: `Recorded finding ${id} in ${backend.describe()}.`,
        metadata: { finding_id: id, severity: args.severity, category: args.category },
      }
    },
  })
}
