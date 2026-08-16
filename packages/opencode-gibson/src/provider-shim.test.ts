import { test } from "node:test"
import assert from "node:assert/strict"
import { startCompletionsShim, type RunningShim } from "@zerocool/sdk"

/**
 * Depth-1 completion (#6): the zero-config `gibson` provider points
 * `@ai-sdk/openai-compatible` at the SDK shim, and the ordinary interactive
 * turn is a STREAMING request with the agent's tools attached. These tests
 * drive that exact consumer path — OpenAI-shaped HTTP against the shim from
 * the pinned SDK, with the harness faked — so a pin regression to a shim
 * that 400s on stream or drops tools fails this suite, not a user's session.
 */

async function withShim(component: unknown, fn: (shim: RunningShim) => Promise<void>): Promise<void> {
  const shim = await startCompletionsShim({ component: component as never, port: 0 })
  try {
    await fn(shim)
  } finally {
    await shim.close()
  }
}

function frames(text: string): { frames: Record<string, unknown>[]; done: boolean } {
  const out: Record<string, unknown>[] = []
  let done = false
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6)
    if (payload === "[DONE]") { done = true; continue }
    out.push(JSON.parse(payload) as Record<string, unknown>)
  }
  return { frames: out, done }
}

test("the provider's streaming turn renders token-by-token through CompleteStream", async () => {
  const component = {
    completeStream: (_req: unknown) =>
      (async function* () {
        yield { content: "scanning ", done: false }
        yield { content: "example.com", done: false }
        yield { content: "", done: true, usage: { inputTokens: 5, outputTokens: 3 } }
      })(),
  }
  await withShim(component, async (shim) => {
    const res = await fetch(`${shim.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", stream: true, messages: [{ role: "user", content: "scan" }] }),
    })
    assert.equal(res.status, 200, "stream:true must not 400 — that was the pre-#6 behavior")
    const { frames: fs, done } = frames(await res.text())
    assert.ok(done)
    const text = fs
      .map((f) => ((f.choices as { delta: { content?: string } }[])?.[0]?.delta.content as string) ?? "")
      .join("")
    assert.equal(text, "scanning example.com")
  })
})

test("the agent loop's tools reach the model and calls come back as tool_calls", async () => {
  let sawTools: string[] = []
  const component = {
    completeWithTools: async (req: { tools: { name: string }[] }) => {
      sawTools = req.tools.map((t) => t.name)
      return {
        response: { role: "assistant", content: "" },
        toolCalls: [{ id: "call_1", name: "bash", argumentsJson: '{"command":"ls"}' }],
        finishReason: "tool_calls",
        usage: { inputTokens: 9, outputTokens: 4 },
      }
    },
  }
  await withShim(component, async (shim) => {
    const res = await fetch(`${shim.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "primary",
        stream: true, // opencode's loop streams even when calling tools
        messages: [{ role: "user", content: "list the files" }],
        tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
      }),
    })
    assert.equal(res.status, 200)
    const { frames: fs, done } = frames(await res.text())
    assert.ok(done)
    assert.deepEqual(sawTools, ["bash"], "tools must reach the harness, not be dropped")
    const first = (fs[0].choices as { delta: { tool_calls?: { function: { name: string } }[] } }[])[0].delta
    assert.equal(first.tool_calls?.[0].function.name, "bash")
    const last = (fs[fs.length - 1].choices as { finish_reason: string | null }[])[0]
    assert.equal(last.finish_reason, "tool_calls")
  })
})

test("the loop's second step carries the tool result on a transportable role", async () => {
  // The step that broke: opencode replays the tool result as an OpenAI
  // `role: "tool"` message. `LLMMessage` has no `tool_call_id`, and a
  // provider rejects a tool-role turn without one, so the whole request
  // failed — the first tool call worked and the turn carrying its result did
  // not. Nothing the shim sends may reach the harness with role "tool".
  let sawRoles: string[] = []
  let sawContent: string[] = []
  const component = {
    completeWithTools: async (req: { messages: { role: string; content: string }[] }) => {
      sawRoles = req.messages.map((m) => m.role)
      sawContent = req.messages.map((m) => m.content)
      return {
        response: { role: "assistant", content: "index.ts is there" },
        finishReason: "stop",
        usage: { inputTokens: 14, outputTokens: 6 },
      }
    },
  }
  await withShim(component, async (shim) => {
    const res = await fetch(`${shim.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "primary",
        stream: true,
        messages: [
          { role: "user", content: "list the files" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "index.ts" },
        ],
        tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
      }),
    })
    assert.equal(res.status, 200)
    const { done } = frames(await res.text())
    assert.ok(done)
    assert.ok(!sawRoles.includes("tool"), `no message may carry role "tool", got ${JSON.stringify(sawRoles)}`)
    assert.deepEqual(sawRoles, ["user", "assistant", "user"])
    assert.match(sawContent[1], /\[tool_calls\].*bash/, "the requested call stays in the transcript")
    assert.match(sawContent[2], /^\[tool_result call_1\] index\.ts$/, "the result keeps its originating call id")
  })
})
