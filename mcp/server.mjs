#!/usr/bin/env node
// camofox-browser MCP server
//
// Standalone Model Context Protocol server that exposes the camofox-browser
// REST API (default http://localhost:9377) as MCP tools. Tool names, schemas,
// REST routes, request bodies, auth, and response shaping are imported from
// lib/mcp-tool-contracts.mjs — the SAME source of truth the OpenClaw plugin
// (plugin.ts) uses — so behavior is identical whether an agent reaches camofox
// via OpenClaw or MCP. Drift is structurally impossible.
//
// Transport: stdio (Claude Code / Codex / agy / Cursor / opencode spawn this as
// a child process). The camofox REST server itself must be running (npm start) —
// this server only forwards calls, it does not launch the browser.
//
// Auth:
//   - CAMOFOX_ACCESS_KEY (global): forwarded as `Authorization: Bearer` on every
//     request so globally-authenticated REST servers accept MCP traffic.
//   - CAMOFOX_API_KEY (cookie import): forwarded as `Authorization: Bearer` on
//     the cookie-import route only.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { loadConfig } from "../lib/config.js";
import {
  TOOL_DEFS,
  runTool,
  adaptResponse,
} from "../lib/mcp-tool-contracts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Version from this package's own package.json (single source — no hardcoded
// duplicate). mcp/ is an independently installable package (@askjo/camofox-mcp)
// with its own manifest, so this reads locally rather than the parent repo's.
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "package.json"), "utf8")
).version;

// Server config (apiKey / accessKey / cookiesDir / port). Loaded once; env wins
// over loadConfig() for MCP-specific overrides via CAMOFOX_BASE_URL.
const CONFIG = loadConfig();
const BASE_URL = process.env.CAMOFOX_BASE_URL || `http://localhost:${CONFIG.port}`;

// Per-MCP-server userId so each host session gets an isolated camofox session
// (cookie/storage partition). Falls back to a random id.
const USER_ID = process.env.CAMOFOX_USER_ID || `mcp-${randomUUID()}`;
// sessionKey partitions tabs within a user (matches plugin.ts fallback "default").
const SESSION_KEY = process.env.CAMOFOX_SESSION_KEY || "default";

// MCP SDK is an optional dependency so the core camofox install stays light.
// Surface a clear, actionable error if it is missing instead of a stack trace.
let Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema;
try {
  const serverMod = await import("@modelcontextprotocol/sdk/server/index.js");
  Server = serverMod.Server;
  const stdioMod = await import("@modelcontextprotocol/sdk/server/stdio.js");
  StdioServerTransport = stdioMod.StdioServerTransport;
  const typesMod = await import("@modelcontextprotocol/sdk/types.js");
  CallToolRequestSchema = typesMod.CallToolRequestSchema;
  ListToolsRequestSchema = typesMod.ListToolsRequestSchema;
} catch {
  console.error(
    "[camofox-mcp] @modelcontextprotocol/sdk is not installed.\n" +
      "Install it with:  npm install @modelcontextprotocol/sdk\n" +
      "(It is an optionalDependency of this package — add it where you run the MCP server.)"
  );
  process.exit(1);
}

const server = new Server(
  { name: "camofox-browser", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }
  try {
    const { spec, payload } = await runTool(
      name,
      args || {},
      { userId: USER_ID, sessionKey: SESSION_KEY },
      BASE_URL,
      CONFIG
    );
    const content = adaptResponse(spec, payload);
    return { content };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `camofox error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[camofox-mcp] v${VERSION} connected → ${BASE_URL} (user=${USER_ID})`
);
