# camofox-browser DSH adapter

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH) host adapter that exposes camofox-browser as **native DSH tools**.

It mirrors the MCP server and the OpenClaw plugin **1:1**: same 11 tool names, identical JSON-Schema parameters, same REST routes, same auth, same response shaping — all imported from the canonical [`mcp/lib/tool-contracts.mjs`](../mcp/lib/tool-contracts.mjs). Adding a host does not fork the contract, so all three clients emit identical traffic to the REST server.

## Architecture

Same shape as `mcp/`: a thin client over the REST server. Two pieces:

- **REST server** (`server.js`) — launches Camoufox, serves the HTTP API on `:9377`. Run **once**, it stays up.
- **DSH adapter** (`dsh/index.js`) — registers the 11 tools with the DSH host. No browser binary, no Playwright, no `camoufox-js`.

```
DSH ──calls camofox_* tools──▶ dsh/index.js ──REST──▶ camofox-browser :9377 ──▶ Camoufox
```

DSH differs from MCP in exactly two ways, and `dsh/index.js` handles both:

1. DSH asks a plugin to **register** tools (`ctx.inject(["tools"], …)`) instead of answering a `ListTools` request.
2. DSH wants each tool to declare how its return value becomes content blocks (`output.render`), so the contract's `adaptResponse()` is wired in as the renderer.

## 1. Start the REST server

```bash
git clone https://github.com/jo-inc/camofox-browser && cd camofox-browser
npm install   # downloads Camoufox (~500MB) on first run
npm start     # → http://localhost:9377
```

## 2. Install the adapter

From a DSH profile, point the plugin loader at this directory:

```bash
dsh plugin --profile desktop add link:<path-to-camofox-browser>/dsh
```

Host-side tools become available immediately — no application restart needed.

## Configuration

Optional; defaults work against a local server. Set in the profile's `cordis.patch.yml` under `id: camofox-browser-dsh`, or via environment variables (the same names the MCP server uses):

| Env var | Default | Purpose |
|---|---|---|
| `CAMOFOX_BASE_URL` | `http://localhost:$CAMOFOX_PORT` | REST server origin |
| `CAMOFOX_PORT` | `9377` | Port used to derive the base URL |
| `CAMOFOX_USER_ID` | `dsh-<uuid>` | Session owner; scopes cookies/localStorage |
| `CAMOFOX_SESSION_KEY` | `default` | Partitions tabs within a user |
| `CAMOFOX_ACCESS_KEY` | – | Global bearer token, for servers exposed beyond loopback |
| `CAMOFOX_API_KEY` | – | Required for `camofox_import_cookies` only |
| `CAMOFOX_COOKIES_DIR` | `~/.camofox/cookies` | Cookie file directory for `camofox_import_cookies` |

The default `dsh-<uuid>` userId keeps a DSH install from sharing a cookie/storage partition with an MCP client pointed at the same REST server.

## Tools

The same 11 as every other host:

`camofox_create_tab` · `camofox_snapshot` · `camofox_click` · `camofox_type` · `camofox_navigate` · `camofox_scroll` · `camofox_screenshot` · `camofox_close_tab` · `camofox_list_tabs` · `camofox_evaluate` · `camofox_import_cookies`

`camofox_snapshot` and `camofox_screenshot` return image content blocks (a base64 PNG). Hosts that keep images out of the model context should persist them instead — see the `dsh-camofox-browser` community plugin for one approach.

## Test

```bash
node dsh/test/smoke.mjs
```

The registration layer always runs (against a fake DSH host). The live REST checks self-skip when no server is reachable, so this is safe in CI without the engine:

```
registration
  ok  registers all 11 canonical tools
  ok  tool names match the shared contract
  ok  parameters are the contract's JSON Schema, untouched
  ok  every tool renders a value into content blocks
  ok  render falls back instead of throwing on an empty value
live REST (skipped when no server is running)
  ok  create_tab returns a tabId
  ok  list_tabs includes the new tab
  ok  close_tab succeeds
  ok  an aborted signal actually aborts the request
```
