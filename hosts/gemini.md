# Gemini CLI

Gemini reads `~/.gemini/settings.json`, or `.gemini/settings.json` in a
project:

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

Check it from a prompt:

```sh
gemini --prompt "call the gibson_status tool and print what it returns"
```

`/mcp` inside the session lists the server and its tools.
