# zerocool-plugins

**Zerocool connects coding agents to [Gibson](https://zeroroot.ai): opencode,
Claude Code, Cursor, Codex CLI, Gemini CLI and Windsurf.**

Install a plugin and your coding agent gains Gibson. The tools are the same
everywhere: one MCP server, `@zeroroot-ai/gibson-mcp`, exposing every RPC of
every SDK service, every SDK helper and every platform tool checked in for
your tenant ([ADR-0008](docs/adr/0008-gibson-mcp-server-one-tool-surface.md)).
A host adapter adds what only that host can do: for opencode, the model
routed through the harness.

## Install

The tools come from one package, `@zeroroot-ai/gibson-mcp`, and every host runs
it the same way:

```sh
npx --package @zeroroot-ai/gibson-mcp gibson-mcp --transport stdio
```

Two hosts get a bundle that runs it for you, because they have a hook surface:
Claude Code and opencode, below. Every other host reads a config file, and
[`hosts/`](hosts/) has one snippet each.

Point it at your platform with `GIBSON_PLATFORM_URL`. With no platform the
server still starts, the tools that need one say so, and your agent keeps
working.

To work on the plugins rather than use them: `pnpm install && pnpm build`,
then point opencode at `packages/opencode-gibson`.

## Claude Code

```sh
claude plugin marketplace add zeroroot-ai/zerocool-plugins
claude plugin install zerocool@zerocool
```

The plugin is a bundle around the Gibson MCP server. Its `.mcp.json` spawns
`@zeroroot-ai/gibson-mcp` over stdio, and it adds two hooks of its own:
SessionStart injects the ambient knowledge block the server wrote, and
SessionEnd checkpoints the transcript to the session store. It holds no tools
and never routes model traffic: your Claude login pays for the model
([ADR-0008](docs/adr/0008-gibson-mcp-server-one-tool-surface.md),
[ADR-0007](docs/adr/0007-claude-code-plugin-session-is-a-live-mission.md)).

The server checks in on its own, and how depends on what is present when it
starts. Set `GIBSON_PLATFORM_URL` and ask Claude for `gibson_status` to see
which of the three sources it used. `GIBSON_TARGET_ID` binds the session's
mission to a target; `GIBSON_BOOTSTRAP_TOKEN` is read on a first start only;
`GIBSON_CA_CERT` trusts a private CA.

## Banks of always-on Claude Code

A **bank** is N Claude Code instances a person or a tenant asked for. The
daemon keeps them running in gVisor sandboxes, and anyone with `can_send`
gives one a structured **job**: a goal, repositories, credentials, an
acceptance rule. A job is a persistent Claude Code conversation with its own
worktrees, and it stays open across back-and-forth with a verifier until a
scorer closes it.

`@zeroroot-ai/zerocool-claude-member` is the driver inside such a sandbox: the
job table, the workspace manager, the per-turn grant and the status heartbeat.
It spawns the unmodified `claude` CLI. See
[`packages/claude-member/README.md`](packages/claude-member/README.md) for the
environment contract, and `CONTEXT.md` § Glossary for the vocabulary.

## Durable sessions

`@zeroroot-ai/zerocool-sessions` is opt-in and installs beside the main plugin:

```json
{ "plugin": ["@zeroroot-ai/zerocool", "@zeroroot-ai/zerocool-sessions"] }
```

With a platform it copies each session to the daemon session store on every
`session.updated` and `message.updated`, keyed by opencode's own session id and
by your tenant. Set `GIBSON_OPENCODE_SESSION_ID` to the session you are
continuing and it reads that session back on start. Writes are debounced;
`ZEROCOOL_SESSION_MIRROR_DEBOUNCE_MS` changes the window, which defaults to
2000 ms.

With no platform it does nothing at all, and opencode uses its own disk, as it
always does. It degrades the same way if the store is unreachable: one warning,
then the session runs on local disk.

## Any coding agent

Cursor, Codex CLI, Gemini CLI and Windsurf reach Gibson through the same MCP
server, with one config snippet each. See [`hosts/`](hosts/): the file per
host, the three check-in sources, and the environment every snippet reads.

## Packages

- **`@zeroroot-ai/zerocool`** — the opencode host adapter. Zero-config LLM
  through the Gibson harness, ambient knowledge, and the Gibson MCP server
  registered for you.
- **`@zeroroot-ai/zerocool-claude`** — the Claude Code host adapter: the plugin
  bundle around the Gibson MCP server, plus SessionStart and SessionEnd hooks.
  The model stays on your Claude login.
- **`@zeroroot-ai/zerocool-claude-member`** — the always-on Claude Code member
  driver for Gibson banks: the job table, the workspace manager and the
  per-turn grant.
- **`@zeroroot-ai/zerocool-exec`** (opt-in) — run execution in the setec Devbox.
- **`@zeroroot-ai/zerocool-sessions`** (opt-in) — durable sessions. It mirrors
  the opencode session to the Gibson daemon session store as it changes, and
  restores it on start, so a session survives a restart of the host. opencode
  keeps its own storage; this is a copy in the tenant's trusted store.

All build on **[`@zeroroot-ai/sdk`](https://www.npmjs.com/package/@zeroroot-ai/sdk)**,
the framework-agnostic TypeScript Gibson SDK, and every tool they expose comes
from **[`@zeroroot-ai/gibson-mcp`](https://www.npmjs.com/package/@zeroroot-ai/gibson-mcp)**.
Both are released on the SDK train, so an SDK bump updates the tool set.

## Dispatched mode: `zerocool-serve`

`@zeroroot-ai/zerocool` also ships a headless entrypoint, **`zerocool-serve`**
(`bin` of the package). Instead of a human driving the agent, the daemon does:
the process checks in with the Capability Grant handshake, registers as a
`kind=tool` component, heartbeats, and blocks on `PollWork`. A mission node can
then dispatch work to it — the first served capability is `http_probe` (one GET,
reported as structured facts, body measured and never returned).

```sh
GIBSON_PLATFORM_URL=https://api.example:30443 \
GIBSON_BOOTSTRAP_TOKEN=<one-time enrollment token> \
ZEROCOOL_TOOL_NAME=zerocool-http \
  zerocool-serve
```

The bootstrap token is needed for the first check-in only; the persisted host
key (`~/.zerocool/host.key`) re-registers the host afterwards. Handlers receive
the session's Gibson clients, so a served tool can call LLM, tools, findings and
knowledge through the callback harness during a dispatched run.

See [`CONTEXT.md`](CONTEXT.md) and [`docs/adr/`](docs/adr/).

## License

MIT.

## License and history

Elastic License 2.0. See [LICENSE](LICENSE). Zero Root AI is the licensor.

Issue and pull request numbers cited in comments and documents dated before 2026-09-05 refer to the tracker before the history reset, archived offline. They do not resolve on GitHub.
