# Gibson in any coding agent

One MCP server serves every host: `@zeroroot-ai/gibson-mcp` (ADR-0008). It
exposes every RPC of every SDK service, every SDK helper, and every platform
tool checked in for your tenant. A host is an adapter around it and holds no
tools of its own.

Two hosts get a bundle, because they have a hook surface:

- **Claude Code** — `claude plugin marketplace add zeroroot-ai/zerocool-plugins`,
  then `claude plugin install zerocool@zerocool`.
- **opencode** — install `@zeroroot-ai/zerocool`, which also routes the model
  through the Gibson harness.

Every other host reads a config file. One snippet each:

| Host | File | Snippet |
|---|---|---|
| Cursor | `.cursor/mcp.json` | [cursor.md](cursor.md) |
| Codex CLI | `~/.codex/config.toml` | [codex.md](codex.md) |
| Gemini CLI | `~/.gemini/settings.json` | [gemini.md](gemini.md) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | [windsurf.md](windsurf.md) |

## Checking in

The server takes its credential from what is present when it starts, and the
three sources are never mixed:

1. **Dispatched grant.** The daemon launched the process and injected
   `GIBSON_CG_JWT` and `GIBSON_CALLBACK_ENDPOINT`. It joins that run. This
   wins whenever it is present.
2. **Pre-minted bootstrap token.** You minted a one-time token earlier and
   start the server once with `GIBSON_BOOTSTRAP_TOKEN`. The host key serves
   from then on.
3. **Human once.** You sign in from inside the session with the device flow.
   The host key serves from then on.

The server never mints an identity of its own (ADR-0045).

## The environment every snippet reads

| Variable | What it does |
|---|---|
| `GIBSON_PLATFORM_URL` | the daemon to reach, for example `https://api.example:30443` |
| `GIBSON_BOOTSTRAP_TOKEN` | one-time enrollment token, first start only |
| `GIBSON_TARGET_ID` | the target a session's mission binds to |
| `GIBSON_CA_CERT` | a private CA, for a self-hosted platform |

Without `GIBSON_PLATFORM_URL` the server still starts. It runs standalone,
the tools that need the platform say so, and your agent keeps working.
