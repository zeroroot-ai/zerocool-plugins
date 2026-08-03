import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { componentizeTool } from "./componentize.js"
import { delegationTools } from "./delegate.js"
import { buildGibsonTools, toolKey } from "./gibson-tools.js"
import { recallTool } from "./knowledge.js"
import { localFindingsBackend, submitFindingTool } from "./findings.js"

/** A minimal ToolContext — only the fields these tools actually read. */
const ctx = (directory = process.cwd()) =>
  ({
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "zerocool",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }) as never

/** Build a fake GibsonSession whose component client is the given stub. */
const session = (component: Record<string, unknown>) =>
  ({ clients: { component }, componentScope: "test", instanceId: "i-1", stop: () => {} }) as never

const unimplemented = () => {
  throw Object.assign(new Error("unimplemented"), { code: "unimplemented" })
}

// ---------------------------------------------------------------------------
// #7 findings
// ---------------------------------------------------------------------------

test("submit_finding writes JSONL standalone and keeps the Finding shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-"))
  const path = join(dir, "findings.jsonl")
  const t = submitFindingTool(localFindingsBackend(path), {})

  const result = await t.execute(
    {
      title: "Hardcoded API key",
      description: "A live key is committed in config.ts.",
      category: "secrets-exposure",
      severity: "high",
      evidence: "const KEY = 'sk-live-...'",
    } as never,
    ctx(),
  )

  const written = JSON.parse((await readFile(path, "utf8")).trim())
  assert.equal(written.title, "Hardcoded API key")
  assert.equal(written.severity, "high")
  assert.equal(written.agent_name, "zerocool")
  assert.equal(written.risk_score, 7.5)
  assert.equal(written.evidence[0].content, "const KEY = 'sk-live-...'")
  assert.match(typeof result === "string" ? result : result.output, /Recorded finding/)
})

test("submit_finding attributes to zerocool and stamps the session for provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-"))
  const path = join(dir, "findings.jsonl")
  const t = submitFindingTool(localFindingsBackend(path), { sessionID: "ses_outer" })

  await t.execute(
    { title: "t", description: "d", category: "c", severity: "low" } as never,
    ctx(),
  )

  const written = JSON.parse((await readFile(path, "utf8")).trim())
  assert.equal(written.mission_id, "ses_outer", "session provides finding provenance")
  // agent_name is not an argument — a model must not attribute findings elsewhere.
  assert.ok(!("agent_name" in t.args))
})

test("submit_finding routes to Gibson when a session exists", async () => {
  let captured: { finding: Uint8Array } | undefined
  const t = submitFindingTool(
    {
      submit: async (f) => {
        captured = { finding: new TextEncoder().encode(JSON.stringify(f)) }
        return "srv-1"
      },
      describe: () => "the tenant Gibson graph",
    },
    {},
  )

  const result = await t.execute(
    { title: "t", description: "d", category: "injection", severity: "critical" } as never,
    ctx(),
  )

  assert.ok(captured)
  const output = typeof result === "string" ? result : result.output
  assert.match(output, /srv-1/)
  assert.match(output, /tenant Gibson graph/)
})

// ---------------------------------------------------------------------------
// #8 knowledge
// ---------------------------------------------------------------------------

test("recall reports the unwired daemon instead of failing the turn", async () => {
  const t = recallTool(session({ queryNodes: unimplemented }))
  const result = await t.execute({ query: "prior sqli findings" } as never, ctx())
  const output = typeof result === "string" ? result : result.output
  assert.match(output, /gibson#1186/)
  assert.match(output, /Continue without prior context/)
})

test("recall renders hits as a prompt-ready block", async () => {
  const t = recallTool(
    session({
      queryNodes: async () => ({
        results: [
          {
            score: 0.9,
            distance: 0,
            node: {
              id: "f1",
              type: "finding",
              content: "",
              properties: { title: { kind: { case: "stringValue", value: "SQLi in /login" } } },
            },
          },
        ],
      }),
    }),
  )
  const result = await t.execute({ query: "sqli" } as never, ctx())
  const output = typeof result === "string" ? result : result.output
  assert.match(output, /\[finding\] SQLi in \/login/)
})

test("recall says so plainly when the graph has no match", async () => {
  const t = recallTool(session({ queryNodes: async () => ({ results: [] }) }))
  const result = await t.execute({ query: "nothing here" } as never, ctx())
  const output = typeof result === "string" ? result : result.output
  assert.match(output, /Nothing in the tenant graph/)
})

// ---------------------------------------------------------------------------
// #9 Gibson tools
// ---------------------------------------------------------------------------

test("toolKey namespaces and sanitises a Gibson tool name", () => {
  assert.equal(toolKey("nmap"), "gibson_nmap")
  assert.equal(toolKey("web.scan-v2"), "gibson_web_scan_v2")
})

test("discovered tools are registered individually alongside the dispatcher", async () => {
  const { tools, discovered } = await buildGibsonTools(
    session({
      listTools: async () => ({
        tools: [
          {
            name: "nmap",
            version: "1.0.0",
            description: "port scanner",
            tags: [],
            inputMessageType: "gibson.tool.v1.ScanRequest",
            outputMessageType: "gibson.tool.v1.ScanResponse",
          },
        ],
      }),
    }),
  )

  assert.equal(discovered, 1)
  assert.ok("gibson_nmap" in tools, "each discovered tool gets its own entry")
  assert.ok("gibson_call_tool" in tools, "the dispatcher is always present")
  assert.ok("gibson_list_tools" in tools)
  assert.ok("gibson_query_plugin" in tools)
  // The input message type must reach the model — it is the only schema hint.
  assert.match(tools.gibson_nmap.description, /gibson\.tool\.v1\.ScanRequest/)
})

test("failed discovery still yields a usable dispatcher", async () => {
  const { tools, discovered, note } = await buildGibsonTools(session({ listTools: unimplemented }))
  assert.equal(discovered, 0)
  assert.match(note ?? "", /gibson#1186/)
  assert.ok("gibson_call_tool" in tools, "a known tool name must still be reachable")
})

test("a discovered tool cannot shadow a built-in", async () => {
  const { tools } = await buildGibsonTools(
    session({
      listTools: async () => ({
        tools: [
          {
            name: "call_tool",
            version: "1",
            description: "impostor",
            tags: [],
            inputMessageType: "",
            outputMessageType: "",
          },
        ],
      }),
    }),
  )
  assert.ok(!tools.gibson_call_tool.description.includes("impostor"))
})

test("a tool error is reported, not thrown, so the agent loop can react", async () => {
  const { tools } = await buildGibsonTools(
    session({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({
        outputJson: "",
        error: { code: "TOOL_NOT_FOUND", message: "no such tool", retryable: false },
      }),
    }),
  )
  const result = await tools.gibson_call_tool.execute({ name: "ghost", input: {} } as never, ctx())
  const output = typeof result === "string" ? result : result.output
  assert.match(output, /TOOL_NOT_FOUND/)
})

// ---------------------------------------------------------------------------
// #10 delegate + missions
// ---------------------------------------------------------------------------

test("delegation tools cover the full mission lifecycle", () => {
  const tools = delegationTools(session({}))
  for (const key of [
    "gibson_list_agents",
    "gibson_delegate",
    "gibson_create_mission",
    "gibson_run_mission",
    "gibson_mission_status",
    "gibson_mission_results",
    "gibson_cancel_mission",
  ]) {
    assert.ok(key in tools, `missing ${key}`)
  }
})

test("delegate explains the unwired daemon rather than leaking 'unimplemented'", async () => {
  const tools = delegationTools(session({ delegateToAgent: unimplemented }))
  const result = await tools.gibson_delegate.execute(
    { agent: "recon", goal: "enumerate" } as never,
    ctx(),
  )
  const output = typeof result === "string" ? result : result.output
  assert.match(output, /gibson#1186/)
  assert.match(output, /Complete the work directly/)
})

test("a policy denial is surfaced verbatim and not retried", async () => {
  let calls = 0
  const tools = delegationTools(
    session({
      delegateToAgent: async () => {
        calls++
        throw Object.assign(new Error("rules of engagement forbid this target"), {
          code: "permission_denied",
        })
      },
    }),
  )
  const result = await tools.gibson_delegate.execute(
    { agent: "recon", goal: "scan prod" } as never,
    ctx(),
  )
  const output = typeof result === "string" ? result : result.output
  assert.equal(calls, 1, "a denial must not be retried")
  assert.match(output, /rules of engagement forbid this target/)
})

test("delegate passes the goal and constraints through in Go field names", async () => {
  let captured: { agentName: string; taskJson: Uint8Array } | undefined
  const tools = delegationTools(
    session({
      delegateToAgent: async (req: { agentName: string; taskJson: Uint8Array }) => {
        captured = req
        return { resultJson: new TextEncoder().encode(JSON.stringify({ Status: "success", Output: "ok" })) }
      },
    }),
  )

  await tools.gibson_delegate.execute(
    { agent: "recon", goal: "enumerate endpoints", max_turns: 3, allowed_tools: ["nmap"] } as never,
    ctx(),
  )

  const task = JSON.parse(new TextDecoder().decode(captured!.taskJson))
  assert.equal(task.Goal, "enumerate endpoints")
  assert.equal(task.Constraints.MaxTurns, 3)
  assert.deepEqual(task.Constraints.AllowedTools, ["nmap"])
})

// ---------------------------------------------------------------------------
// #11 componentize
// ---------------------------------------------------------------------------

test("componentize writes a manifest for a valid artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-"))
  const t = componentizeTool()

  const result = await t.execute(
    {
      kind: "tool",
      name: "produced-scanner",
      version: "0.1.0",
      image: "ghcr.io/tenant/produced-scanner:0.1.0",
      language: "rust",
      input_message_type: "gibson.tool.v1.ScanRequest",
      output_message_type: "gibson.tool.v1.ScanResponse",
    } as never,
    ctx(dir),
  )

  const output = typeof result === "string" ? result : result.output
  assert.match(output, /Wrote a valid tool manifest/)
  const manifest = JSON.parse(await readFile(join(dir, "gibson-component.json"), "utf8"))
  assert.equal(manifest.kind, "tool")
  assert.equal(manifest.metadata.image, "ghcr.io/tenant/produced-scanner:0.1.0")
  assert.equal(manifest.metadata.language, "rust", "the contract is language-neutral but records it")
})

test("componentize rejects an artifact that breaks the contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-"))
  const result = await componentizeTool().execute(
    { kind: "tool", name: "half-built", version: "0.1.0" } as never,
    ctx(dir),
  )
  const output = typeof result === "string" ? result : result.output
  assert.match(output, /does not satisfy Gibson's tool contract/)
  assert.match(output, /outputMessageType/)
})

test("componentize warns when no image reference was supplied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerocool-"))
  const result = await componentizeTool().execute(
    { kind: "agent", name: "produced-agent", version: "0.1.0", capabilities: ["recon"] } as never,
    ctx(dir),
  )
  const output = typeof result === "string" ? result : result.output
  assert.match(output, /cannot be dispatched/)
})
