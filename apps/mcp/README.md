# Meeting Context Router MCP

This package runs the stdio MCP client. Run the separate Meeting Context Router API first.

After the package is published, configure your MCP client with:

```json
{
  "mcpServers": {
    "meeting-context-router": {
      "command": "npx",
      "args": ["--yes", "@meeting-context-router/mcp@0.1.0"],
      "env": { "ROUTER_BASE_URL": "http://127.0.0.1:4300" }
    }
  }
}
```

If the API requires authentication, supply the bridge-scoped token via `MEETING_ROUTER_MCP_TOKEN` in the client environment.
