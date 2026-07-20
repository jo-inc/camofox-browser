# camofox-browser MCP server

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that exposes camofox-browser to any MCP-compatible host — Claude Code, Cursor, etc. — without requiring OpenClaw.

It mirrors the existing OpenClaw plugin **1:1**: same 11 tool names, identical JSON-Schema parameters, and the same REST routes. Whether an agent reaches camofox via OpenClaw or MCP, the behavior is identical.

## Architecture

The MCP server is a thin stdio client over the camofox REST server. Two pieces:

- **REST server** (`server.js`) — launches Camoufox, exposes the HTTP API on `:9377`. Run **once**, it stays up.
- **MCP server** (`mcp/server.mjs`, exposed as the `camofox-mcp` bin) — translates MCP tool calls into REST calls. Claude Code spawns one **per session**.

Registering the MCP server does **not** require being inside the camofox-browser checkout. The examples below work from any directory.

## 1. Start the REST server

Clone the repo and start the server (one-time binary download on first run):

```bash
git clone https://github.com/jo-inc/camofox-browser && cd camofox-browser
npm install   # downloads Camoufox (~300MB) on first run
npm start     # → http://localhost:9377
```

This stays running in the background. It does not need to be your cwd afterwards.

## 2. Install the `camofox-mcp` bin

The MCP server is the same for every host — what differs is only the config file you paste into. First, make the `camofox-mcp` bin available on your PATH. Pick one:

```bash
# Option A — npm link (if you have the source checkout; picks up local edits)
cd camofox-browser && npm link

# Option B — global install (no source checkout needed)
npm install -g @askjo/camofox-browser

# Option C — npx (no install; pins to a published version)
#   use `npx -y @askjo/camofox-browser mcp` wherever a command is expected below
```

Verify the bin resolves from any directory:

```bash
which camofox-mcp   # → .../bin/camofox-mcp
```

## 3. Register with your host

All five hosts speak standard MCP, so they all run the same `camofox-mcp` bin. Pick your host's config snippet below.

### Claude Code

```bash
# CLI (user scope = available in every project)
claude mcp add camofox-browser -s user -- camofox-mcp
```

Or in `~/.claude.json` (user) / `.mcp.json` (project, checked in):

```json
{
  "mcpServers": {
    "camofox-browser": {
      "command": "camofox-mcp"
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml` (user) or `.codex/config.toml` (project, trusted dirs only):

```toml
[mcp_servers.camofox-browser]
command = "camofox-mcp"
env = { CAMOFOX_BASE_URL = "http://localhost:9377" }
```

### Antigravity / agy

Global `~/.gemini/config/mcp_config.json` or workspace `.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "camofox-browser": {
      "command": "camofox-mcp"
    }
  }
}
```

### Cursor

Global `~/.cursor/mcp.json` or project `.cursor/mcp.json` (checked in):

```json
{
  "mcpServers": {
    "camofox-browser": {
      "command": "camofox-mcp"
    }
  }
}
```

(Or via UI: Settings → Cursor Settings → MCP → Add New MCP Server.)

### opencode

`opencode.json` in the project root, or global `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "camofox-browser": {
      "type": "local",
      "command": ["camofox-mcp"]
    }
  }
}
```

### Common: env vars and from-source fallback

If you need cookie import or a non-default REST URL, add env. Example for Claude Code:

```bash
claude mcp add camofox-browser -s user \
  --env CAMOFOX_BASE_URL=http://localhost:9377 \
  --env CAMOFOX_API_KEY=<key> \
  -- camofox-mcp
```

For the other hosts, add the same keys to the `env` / `environment` field of that host's snippet.

**From-source fallback** (only if you're inside the checkout and haven't linked the bin):

```bash
# Replace `camofox-mcp` with `node /absolute/path/to/mcp/server.mjs`
claude mcp add camofox-browser -- node /Users/you/src/camofox-browser/mcp/server.mjs
```

> ⚠️ Always prefer the `camofox-mcp` bin (options A/B/C above). The `node ./mcp/server.mjs` form is **path-dependent** — relative paths break outside the checkout.

## 4. Verify

| Host | How to verify |
|------|---------------|
| Claude Code | `/mcp` — `camofox-browser` shows connected |
| Codex CLI | `codex` then check MCP server list |
| agy | `/mcp` overlay in the `agy` CLI |
| Cursor | Settings → MCP — server shows green |
| opencode | `opencode mcp list` |

You should see 11 tools: `camofox_create_tab`, `camofox_snapshot`, `camofox_click`, `camofox_type`, `camofox_navigate`, `camofox_scroll`, `camofox_screenshot`, `camofox_evaluate`, `camofox_list_tabs`, `camofox_close_tab`, `camofox_import_cookies`.

## Tools

| Tool | Purpose |
|------|---------|
| `camofox_create_tab` | Open a URL → returns `tabId` |
| `camofox_snapshot` | Accessibility snapshot + element refs (`e1`, `e2`, ...) + screenshot |
| `camofox_navigate` | Go to a URL **or** use a search macro (`@google_search`, `@reddit_search`, ...) |
| `camofox_click` | Click by element ref (`e1`) or CSS selector |
| `camofox_type` | Type text into a ref/selector, optional `pressEnter` |
| `camofox_scroll` | Scroll by pixels (unreliable on lazy-load pages — prefer `camofox_evaluate`) |
| `camofox_screenshot` | Standalone screenshot |
| `camofox_evaluate` | Run JS in page context — extract data, call page APIs, scroll via `window.scrollTo` |
| `camofox_list_tabs` | List open tabs in this session |
| `camofox_close_tab` | Close a tab |
| `camofox_import_cookies` | Import a Netscape cookie file (needs `CAMOFOX_API_KEY`) |

## Workflow

Every interaction follows the same shape — **snapshot before you act**:

1. `create_tab({ url })` → `tabId`
2. `snapshot({ tabId })` → element refs (`e1`, `e2`, ...)
3. `click`/`type` using those refs
4. `snapshot` again to read the new state
5. `close_tab` when done

Element refs are unambiguous and preferred over CSS selectors — a selector that matches multiple elements returns `422 strict mode violation`, in which case re-snapshot and click by ref.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `CAMOFOX_BASE_URL` | `http://localhost:9377` | REST server URL |
| `CAMOFOX_USER_ID` | `mcp-<random>` | Session isolation (one MCP server = one camofox session) |
| `CAMOFOX_SESSION_KEY` | `default` | Tab partition within the user |
| `CAMOFOX_API_KEY` | _(unset)_ | Self-chosen secret gating cookie import. Optional on localhost; required on remote/production and must match the REST server's `CAMOFOX_API_KEY`. Only affects `camofox_import_cookies`. |

## Troubleshooting

- **`503 session_expired` / `tab create timed out`** — the REST server's browser session died (often after a prior failed call destabilized it). Restart `npm start`.
- **`camofox_scroll` returns `{ok:true}` but the page doesn't move** — expected on lazy-load / virtual-scroll pages; the server's `mouse.wheel` no-ops there. Use `camofox_evaluate` with `window.scrollTo` / `scrollBy`.
- **`422 strict mode violation ... resolved to N elements`** on `click` — CSS selector matched multiple elements. Re-snapshot and click by element ref.
- **`403 Forbidden` on `camofox_import_cookies`** — key mismatch between REST server and MCP server, or hitting a remote server without `CAMOFOX_API_KEY`.

## Smoke test (developer)

A dependency-free smoke test exercises the handshake, all 11 tools, and schemas — no REST server required:

```bash
npm run test:mcp
```
