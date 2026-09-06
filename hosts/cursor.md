# Cursor

Cursor reads `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for
every project. Add the Gibson server:

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

Reload the window. The Gibson tools appear in the MCP panel, and Cursor calls
them like any other tool.

Cursor has no headless mode, so CI validates the shape of this snippet
against the schema every host in this directory shares. It does not drive
Cursor itself.
