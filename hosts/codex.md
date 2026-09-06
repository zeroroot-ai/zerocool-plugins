# Codex CLI

Codex reads `~/.codex/config.toml`. One table per MCP server:

```toml
[mcp_servers.gibson]
command = "npx"
args = ["--yes", "--package", "@zeroroot-ai/gibson-mcp@latest", "gibson-mcp", "--transport", "stdio"]

[mcp_servers.gibson.env]
GIBSON_PLATFORM_URL = "https://api.example:30443"
```

Check it from a prompt:

```sh
codex exec "call the gibson_status tool and print what it returns"
```

The tool answers even with no platform reachable: it reports the standalone
posture and says what is missing.
