import type { ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  buildComponentManifest,
  enrollComponent,
  enrollmentSupported,
  validateComponentSpec,
  type ComponentKind,
  type ComponentSpec,
  type GibsonSession,
} from "@zerocool/sdk"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

/**
 * Componentize produced artifacts into the tenant fleet (zerocool-plugins#11).
 *
 * The factory payoff: an artifact the agent built becomes a registered Gibson
 * component. The contract is language-neutral — `RegisterComponent` describes a
 * component by kind, name, version and contract fields, never by the language
 * it was written in.
 *
 * Two tools, because the work splits at a real boundary:
 *
 *  - `gibson_componentize` writes the manifest to disk without touching the
 *    platform. It is the step that can always run, and the artefact it produces
 *    is what a build pipeline consumes.
 *  - `gibson_enroll_component` registers the manifest with the daemon.
 *
 * WHAT THIS DOES NOT DO. Image build and publish is a build-system concern, not
 * an RPC; the OCI reference is an input here, carried in `metadata.image`. And
 * enrollment currently registers under the CALLING agent's identity — the
 * policy-bounded RPC that would give a produced component its own short-TTL
 * credential is gibson#1185 and does not exist yet. The tool says so in its
 * output rather than implying the artifact is independently dispatchable.
 */

const KINDS = ["agent", "tool", "plugin"] as const

/** Shared argument shape for both tools. */
function specArgs() {
  const z = tool.schema
  return {
    kind: z.enum(KINDS).describe("Component kind."),
    name: z.string().describe("Component name, as it will appear in the tenant registry."),
    version: z.string().describe('Semantic version of the artifact, e.g. "0.1.0".'),
    image: z
      .string()
      .optional()
      .describe("OCI image reference of the built artifact. Required before it can be dispatched."),
    language: z.string().optional().describe("Language the artifact is written in, for the catalog."),
    capabilities: z
      .array(z.string())
      .optional()
      .describe('Agent capabilities. Required when kind is "agent".'),
    methods: z.array(z.string()).optional().describe('Plugin method names. Required when kind is "plugin".'),
    input_message_type: z
      .string()
      .optional()
      .describe('Fully-qualified proto input type. Required when kind is "tool".'),
    output_message_type: z
      .string()
      .optional()
      .describe('Fully-qualified proto output type. Required when kind is "tool".'),
    config_schema_json: z.string().optional().describe("JSON Schema for a plugin's configuration."),
  }
}

/** Build a ComponentSpec from tool arguments. */
function toSpec(args: {
  kind: string
  name: string
  version: string
  image?: string
  language?: string
  capabilities?: string[]
  methods?: string[]
  input_message_type?: string
  output_message_type?: string
  config_schema_json?: string
}): ComponentSpec {
  const metadata: Record<string, string> = {}
  if (args.image) metadata.image = args.image
  if (args.language) metadata.language = args.language
  return {
    kind: args.kind as ComponentKind,
    name: args.name,
    version: args.version,
    metadata,
    ...(args.capabilities ? { capabilities: args.capabilities } : {}),
    ...(args.methods ? { methods: args.methods } : {}),
    ...(args.input_message_type ? { inputMessageType: args.input_message_type } : {}),
    ...(args.output_message_type ? { outputMessageType: args.output_message_type } : {}),
    ...(args.config_schema_json ? { configSchemaJson: args.config_schema_json } : {}),
  }
}

/**
 * Write a validated component manifest to disk. Available with or without a
 * Gibson session — the manifest is the artifact a build pipeline needs, and
 * producing it must not require a platform connection.
 */
export function componentizeTool(): ToolDefinition {
  const z = tool.schema
  return tool({
    description:
      "Turn a built artifact into a Gibson component manifest and write it to disk. " +
      "Use this after building a tool or agent you want to add to the fleet. Validates " +
      "the artifact against Gibson's component contract; does not build or push an image.",
    args: {
      ...specArgs(),
      path: z
        .string()
        .optional()
        .describe('Where to write the manifest. Defaults to "gibson-component.json".'),
    },
    async execute(args, ctx) {
      const spec = toSpec(args)
      const problems = validateComponentSpec(spec)
      if (problems.length > 0) {
        return {
          title: "invalid component spec",
          output: `This artifact does not satisfy Gibson's ${spec.kind} contract:\n${problems.map((p) => `- ${p}`).join("\n")}`,
        }
      }

      const manifest = buildComponentManifest(spec)
      const target = resolve(ctx.directory, args.path ?? "gibson-component.json")
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

      const missingImage = spec.metadata?.image
        ? ""
        : "\n\nNo image reference was given. Build and push an image, then re-run with " +
          "image=<oci-ref> before enrolling — a component without an image cannot be dispatched."

      return {
        title: `${spec.kind} manifest: ${spec.name}`,
        output: `Wrote a valid ${spec.kind} manifest for ${spec.name}@${spec.version} to ${target}.${missingImage}`,
        metadata: { path: target, kind: spec.kind, name: spec.name },
      }
    },
  })
}

/** Register a produced artifact with the tenant registry. */
export function enrollComponentTool(session: GibsonSession): ToolDefinition {
  return tool({
    description:
      "Register a produced artifact with Gibson so it joins the tenant fleet. Run " +
      "gibson_componentize first to check the artifact against the component contract.",
    args: specArgs(),
    async execute(args) {
      const spec = toSpec(args)
      const problems = validateComponentSpec(spec)
      if (problems.length > 0) {
        return {
          title: "invalid component spec",
          output: `This artifact does not satisfy Gibson's ${spec.kind} contract:\n${problems.map((p) => `- ${p}`).join("\n")}`,
        }
      }

      const result = await enrollComponent(session.clients.component, spec)
      const { reason } = enrollmentSupported()

      return {
        title: `enrolled ${spec.name}`,
        output:
          `Registered ${spec.kind} ${spec.name}@${spec.version} as instance ${result.instanceId}.\n\n` +
          `Note: ${reason}. It is visible in the tenant registry, but it will drop out ` +
          `when heartbeats stop (every ${Math.round(result.heartbeatIntervalMs / 1000)}s) ` +
          `unless the artifact itself runs and checks in.`,
        metadata: {
          instance_id: result.instanceId,
          has_own_identity: result.hasOwnIdentity,
          kind: spec.kind,
        },
      }
    },
  })
}
