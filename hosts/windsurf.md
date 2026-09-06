# Windsurf

Windsurf reads `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "gibson": {
      "command": "npx",
      "args": ["--yes", "--package", "@zeroroot-ai/gibson-mcp@latest", "gibson-mcp", "--transport", "stdio"],
      "env": {
        "GIBSON_PLATFORM_URL": "https://api.example:30443"
      }
    }
  }
}
```

Open Cascade, then refresh the MCP servers. The Gibson tools appear in the
tool list.

Windsurf has no headless mode, so CI validates the shape of this snippet
against the schema every host in this directory shares. It does not drive
Windsurf itself.
