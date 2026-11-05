# Using MCP

The package `@askjo/camofox-browser-mcp` exposes the REST API as MCP tools. It proxies to a running Camofox server, so it still needs the base URL and the access key.

- Use it for quick agent work in MCP-capable clients (for example Claude Code, Cursor, Codex).
- Do not make it your only integration. Apps and backend jobs that are not agents should call the REST API directly.
- The same userId rule applies: the client must pass the end user's ID from the authenticated session.
