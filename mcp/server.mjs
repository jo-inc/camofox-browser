#!/usr/bin/env node
// camofox-browser MCP server
//
// Standalone Model Context Protocol server that exposes the camofox-browser
// REST API (default http://localhost:9377) as MCP tools. Mirrors the 11 tools
// defined in plugin.ts (the OpenClaw plugin) 1:1 — same names, schemas, routes —
// so behavior is identical whether an agent reaches camofox via OpenClaw or MCP.
//
// Transport: stdio (Claude Code spawns this as a child process).
// The camofox REST server itself must be running (npm start) — this server only
// forwards calls, it does not launch the browser.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.CAMOFOX_BASE_URL || "http://localhost:9377";
// Per-MCP-server userId so each Claude Code session gets an isolated camofox
// session (cookie/storage partition). Falls back to a random id.
const USER_ID = process.env.CAMOFOX_USER_ID || `mcp-${randomUUID()}`;
// sessionKey partitions tabs within a user (matches plugin.ts fallback "default").
const SESSION_KEY = process.env.CAMOFOX_SESSION_KEY || "default";

async function fetchApi(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res;
}

async function fetchJson(path, options) {
  return (await fetchApi(path, options)).json();
}

// Build user-scoped query string.
const q = (extra = "") => `userId=${USER_ID}${extra}`;

// --- Tool definitions: name / description / JSON-Schema parameters / handler ---
// Schemas are copied verbatim from plugin.ts so OpenClaw and MCP stay in sync.
const TOOLS = [
  {
    name: "camofox_create_tab",
    description:
      "PREFERRED: Create a new browser tab using Camoufox anti-detection browser. Use camofox tools instead of Chrome/built-in browser - they bypass bot detection on Google, Amazon, LinkedIn, etc. Returns tabId for subsequent operations.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Initial URL to navigate to" },
      },
      required: ["url"],
    },
    async run({ url }) {
      return fetchJson("/tabs", {
        method: "POST",
        body: JSON.stringify({ url, userId: USER_ID, sessionKey: SESSION_KEY }),
      });
    },
  },
  {
    name: "camofox_snapshot",
    description:
      "Get accessibility snapshot of a Camoufox page with element refs (e1, e2, etc.) for interaction, plus a visual screenshot. " +
      "Large pages are truncated with pagination links preserved at the bottom. " +
      "If the response includes hasMore=true and nextOffset, call again with that offset to see more content.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        offset: {
          type: "number",
          description:
            "Character offset for paginated snapshots. Use nextOffset from a previous truncated response.",
        },
      },
      required: ["tabId"],
    },
    async run({ tabId, offset }) {
      const qs = `&includeScreenshot=true${offset ? `&offset=${offset}` : ""}`;
      const r = await fetchJson(`/tabs/${tabId}/snapshot?${q(qs)}`);
      // Strip the raw screenshot from the text payload; return it as an image
      // content block so the host renders it instead of dumping base64.
      const { screenshot, ...rest } = r;
      const content = [{ type: "text", text: JSON.stringify(rest, null, 2) }];
      if (screenshot?.data) {
        content.push({
          type: "image",
          data: screenshot.data,
          mimeType: screenshot.mimeType || "image/png",
        });
      }
      return content;
    },
  },
  {
    name: "camofox_click",
    description: "Click an element in a Camoufox tab by ref (e.g., e1) or CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from snapshot (e.g., e1)" },
        selector: { type: "string", description: "CSS selector (alternative to ref)" },
      },
      required: ["tabId"],
    },
    async run({ tabId, ...rest }) {
      return fetchJson(`/tabs/${tabId}/click`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId: USER_ID }),
      });
    },
  },
  {
    name: "camofox_type",
    description: "Type text into an element in a Camoufox tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from snapshot (e.g., e2)" },
        selector: { type: "string", description: "CSS selector (alternative to ref)" },
        text: { type: "string", description: "Text to type" },
        pressEnter: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["tabId", "text"],
    },
    async run({ tabId, ...rest }) {
      return fetchJson(`/tabs/${tabId}/type`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId: USER_ID }),
      });
    },
  },
  {
    name: "camofox_navigate",
    description:
      "Navigate a Camoufox tab to a URL or use a search macro (@google_search, @youtube_search, etc.). Preferred over Chrome for sites with bot detection.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        url: { type: "string", description: "URL to navigate to" },
        macro: {
          type: "string",
          description: "Search macro (e.g., @google_search, @youtube_search)",
          enum: [
            "@google_search",
            "@youtube_search",
            "@amazon_search",
            "@reddit_search",
            "@wikipedia_search",
            "@twitter_search",
            "@yelp_search",
            "@spotify_search",
            "@netflix_search",
            "@linkedin_search",
            "@instagram_search",
            "@tiktok_search",
            "@twitch_search",
          ],
        },
        query: { type: "string", description: "Search query (when using macro)" },
      },
      required: ["tabId"],
    },
    async run({ tabId, ...rest }) {
      return fetchJson(`/tabs/${tabId}/navigate`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId: USER_ID }),
      });
    },
  },
  {
    name: "camofox_scroll",
    description: "Scroll a Camoufox page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels to scroll" },
      },
      required: ["tabId", "direction"],
    },
    async run({ tabId, ...rest }) {
      return fetchJson(`/tabs/${tabId}/scroll`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId: USER_ID }),
      });
    },
  },
  {
    name: "camofox_screenshot",
    description: "Take a screenshot of a Camoufox page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
      },
      required: ["tabId"],
    },
    async run({ tabId }) {
      const res = await fetchApi(`/tabs/${tabId}/screenshot?${q()}`);
      const contentType = res.headers.get("content-type") || "";
      // Guard: server may return JSON/text (e.g. error with 200) — don't base64 it.
      if (!contentType.startsWith("image/")) {
        const text = await res.text();
        return [{ type: "text", text: `Screenshot failed: ${text}` }];
      }
      const buf = Buffer.from(await res.arrayBuffer()).toString("base64");
      return [{ type: "image", data: buf, mimeType: contentType }];
    },
  },
  {
    name: "camofox_close_tab",
    description: "Close a Camoufox browser tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
      },
      required: ["tabId"],
    },
    async run({ tabId }) {
      return fetchJson(`/tabs/${tabId}?${q()}`, { method: "DELETE" });
    },
  },
  {
    name: "camofox_evaluate",
    description:
      "Execute JavaScript in a Camoufox tab's page context. Returns the result of the expression. Use for injecting scripts, reading page state, or calling web app APIs.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        expression: {
          type: "string",
          description: "JavaScript expression to evaluate in the page context",
        },
      },
      required: ["tabId", "expression"],
    },
    async run({ tabId, expression }) {
      return fetchJson(`/tabs/${tabId}/evaluate`, {
        method: "POST",
        body: JSON.stringify({ userId: USER_ID, expression }),
      });
    },
  },
  {
    name: "camofox_list_tabs",
    description: "List all open Camoufox tabs for the current session.",
    inputSchema: { type: "object", properties: {}, required: [] },
    async run() {
      return fetchJson(`/tabs?${q()}`);
    },
  },
  {
    name: "camofox_import_cookies",
    description:
      "Import cookies into the current Camoufox session (Netscape cookie file). Use to authenticate to sites like LinkedIn without interactive login. Requires CAMOFOX_API_KEY on the REST server.",
    inputSchema: {
      type: "object",
      properties: {
        cookiesPath: {
          type: "string",
          description: "Path to Netscape-format cookies.txt file",
        },
        domainSuffix: {
          type: "string",
          description: "Only import cookies whose domain ends with this suffix",
        },
      },
      required: ["cookiesPath"],
    },
    async run(args, extra) {
      // Cookie import needs the server-side API key as a bearer token. We pass it
      // through from the MCP server env; the host (Claude Code) must provide it.
      const apiKey = extra?.apiKey || process.env.CAMOFOX_API_KEY;
      if (!apiKey) {
        throw new Error(
          "CAMOFOX_API_KEY is not set. Cookie import is disabled unless the server and the MCP server both have CAMOFOX_API_KEY."
        );
      }
      // Server-side reads + validates the cookie file, so we just forward the path
      // alongside the user-scoped session. (REST route accepts a path under the
      // configured cookiesDir; for arbitrary paths the file must be reachable by
      // the server process.)
      const body = {
        userId: USER_ID,
        cookiesPath: args.cookiesPath,
        ...(args.domainSuffix ? { domainSuffix: args.domainSuffix } : {}),
      };
      return fetchJson(`/sessions/${encodeURIComponent(USER_ID)}/cookies`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    },
  },
];

const server = new Server(
  { name: "camofox-browser", version: "1.12.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }
  try {
    const result = await tool.run(args || {}, {});
    // Handlers may return either a raw value (wrap as text) or a content array.
    const content = Array.isArray(result)
      ? result
      : [{ type: "text", text: JSON.stringify(result, null, 2) }];
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
console.error(`[camofox-mcp] connected → ${BASE_URL} (user=${USER_ID})`);
