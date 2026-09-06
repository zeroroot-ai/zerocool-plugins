# Claude Code stream-json fixtures

One directory per Claude Code version. The driver parses what the CLI really
prints, so a fixture is only worth what its capture is worth (ADR-0006 rule,
the same discipline `opencode-run.test.ts` follows).

## What is in `claude-code-2.1.257`

| File | Source |
|---|---|
| `auth-error-real.jsonl` | **Real.** Captured from `claude` 2.1.257 on this workstation. |
| `job-turn-synthetic.jsonl` | **`synthetic-until-captured`.** Hand-built from the real `system/init` and `result` shapes above, plus the event shapes the Claude Code docs document. |
| `interrupted-turn-synthetic.jsonl` | **`synthetic-until-captured`.** The same turn cut off before its `result`, with one stray non-JSON line. |

`auth-error-real.jsonl` is a complete run of:

```sh
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --dangerously-skip-permissions \
  --mcp-config <http server> --strict-mcp-config \
  --permission-prompt-tool mcp__gibson__ask --max-turns 2 --max-budget-usd 0.5 \
  --append-system-prompt "capture"
```

with `CLAUDE_CONFIG_DIR` pointed at a throwaway directory and a deliberately
invalid `ANTHROPIC_API_KEY`. It carries the real `system/init` (with
`mcp_servers`, `capabilities`, `plugins`, `apiKeySource`,
`claude_code_version`), the real `system/status` and `system/api_retry`
shapes, and the real `result` shape with `total_cost_usd`, `num_turns`,
`duration_ms`, `permission_denials` and `modelUsage`.

The two synthetic files carry what that run could not produce without a paid
key: an MCP tool call, the permission prompt tool answering, a subagent
message with `parent_tool_use_id`, a compact boundary, and a successful
`result`. Their `system/init` is the real one with the MCP server connected,
so the field set stays honest.

## Re-capture procedure

Run this on any version bump of `@anthropic-ai/claude-code`, including a
Renovate bump. It needs an Anthropic API key that is not the workstation's
own login.

1. Set `ANTHROPIC_API_KEY` to a key you may spend on. Never use the
   workstation's subscription login: a capture must not touch it.
2. Make a throwaway config directory and a throwaway working directory:
   `export CLAUDE_CONFIG_DIR=$(mktemp -d)`.
3. Start any MCP server on localhost that exposes an `ask` tool, or point
   `--mcp-config` at the Gibson MCP server over streamable HTTP.
4. Run the command above with a goal that calls one MCP tool and asks one
   question, and redirect stdout to
   `test/fixtures/claude-code-<version>/job-turn-real.jsonl`.
5. Delete the throwaway config directory.
6. Replace `job-turn-synthetic.jsonl` with the real capture, drop the
   `synthetic-until-captured` row from the table above, and update
   `PINNED_CLAUDE_CODE_VERSION` in `src/version.ts` and the
   `CLAUDE_CODE_VERSION` build argument in `Dockerfile.claude`.

A fixture directory for a version the image does not pin is deleted, never
kept (ADR-0027).
