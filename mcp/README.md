# camofox-browser MCP server

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that exposes camofox-browser to any MCP-compatible host — Claude Code, Cursor, etc. — without requiring OpenClaw.

It mirrors the existing OpenClaw plugin **1:1**: same 11 tool names, identical JSON-Schema parameters, and the same REST routes. Whether an agent reaches camofox via OpenClaw or MCP, the behavior is identical.

## How it works

The MCP server only **forwards** calls to the camofox REST server (`localhost:9377` by default). It does not launch the browser itself — start the REST server first, then register the MCP server with your host.

## Quick start

1. Start the REST server (one-time binary download on first run):

   ```bash
   npm install   # downloads Camoufox (~300MB) on first run
   npm start     # → http://localhost:9377
   ```

2. Register the MCP server with your host. For Claude Code:

   ```bash
   claude mcp add camofox-browser \
     --env CAMOFOX_BASE_URL=http://localhost:9377 \
     -- node ./mcp/server.mjs
   ```

   Or run directly with `npm run mcp`, or via the `camofox-mcp` bin after `npm install`.

3. Verify — run `/mcp` in Claude Code. You should see `camofox-browser` connected with all 11 tools.

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

## Verification

A dependency-free smoke test exercises the handshake, all 11 tools, and schemas — no REST server required:

```bash
npm run test:mcp
```
