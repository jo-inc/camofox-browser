/**
 * Canonical tool contracts for the camofox-browser REST API.
 *
 * Single source of truth shared by two hosts that expose the same 11 tools:
 *   - mcp/server.mjs   (stdio MCP server for Claude Code, Codex, agy, Cursor, opencode)
 *   - plugin.ts        (OpenClaw plugin)
 *
 * Importing this module from both hosts means tool names, JSON-Schema
 * parameters, REST routes, request bodies, auth semantics, and response
 * shaping cannot drift — the REST server sees identical traffic regardless of
 * which host the agent reached it through.
 *
 * Auth model (mirrors lib/auth.js):
 *   - CAMOFOX_ACCESS_KEY (global superkey): when set, every route except
 *     /health, cookie import, /auth-sessions, /stop requires
 *     `Authorization: Bearer <accessKey>`.
 *   - CAMOFOX_API_KEY (cookie-only gate): the cookie-import route requires
 *     `Authorization: Bearer <apiKey>` (or loopback + non-production).
 *
 * Each buildRequest() result declares `auth: 'accessKey' | 'apiKey' | 'none'`
 * and `responseKind: 'json' | 'snapshot' | 'image'` so the host's fetch layer
 * and response adapter stay declarative.
 */

import { readCookieFile } from './cookies.js';

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema - JSON Schema (object) for tool arguments.
 */

/**
 * @typedef {Object} RequestSpec
 * @property {string} method - HTTP method.
 * @property {string} path - Path (already includes query string when needed).
 * @property {'accessKey'|'apiKey'|'none'} auth
 * @property {'json'|'snapshot'|'image'} responseKind
 * @property {object} [body] - JSON body.
 * @property {object} [meta] - Extra metadata for response shaping.
 */

/**
 * @typedef {Object} CallContext
 * @property {string} userId - Session owner (scopes cookie/storage partition).
 * @property {string} [sessionKey] - Tab partition within a user.
 */

const SEARCH_MACROS = [
  '@google_search',
  '@youtube_search',
  '@amazon_search',
  '@reddit_search',
  '@wikipedia_search',
  '@twitter_search',
  '@yelp_search',
  '@spotify_search',
  '@netflix_search',
  '@linkedin_search',
  '@instagram_search',
  '@tiktok_search',
  '@twitch_search',
];

/**
 * The 11 tools, identical schema for both hosts. Edit here and both update.
 * @type {ToolDef[]}
 */
export const TOOL_DEFS = [
  {
    name: 'camofox_create_tab',
    description:
      'PREFERRED: Create a new browser tab using Camoufox anti-detection browser. Use camofox tools instead of Chrome/built-in browser - they bypass bot detection on Google, Amazon, LinkedIn, etc. Returns tabId for subsequent operations.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Initial URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'camofox_snapshot',
    description:
      'Get accessibility snapshot of a Camoufox page with element refs (e1, e2, etc.) for interaction, plus a visual screenshot. ' +
      'Large pages are truncated with pagination links preserved at the bottom. ' +
      'If the response includes hasMore=true and nextOffset, call again with that offset to see more content.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        offset: {
          type: 'number',
          description: 'Character offset for paginated snapshots. Use nextOffset from a previous truncated response.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_click',
    description: 'Click an element in a Camoufox tab by ref (e.g., e1) or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        ref: { type: 'string', description: 'Element ref from snapshot (e.g., e1)' },
        selector: { type: 'string', description: 'CSS selector (alternative to ref)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_type',
    description: 'Type text into an element in a Camoufox tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        ref: { type: 'string', description: 'Element ref from snapshot (e.g., e2)' },
        selector: { type: 'string', description: 'CSS selector (alternative to ref)' },
        text: { type: 'string', description: 'Text to type' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing' },
      },
      required: ['tabId', 'text'],
    },
  },
  {
    name: 'camofox_navigate',
    description:
      'Navigate a Camoufox tab to a URL or use a search macro (@google_search, @youtube_search, etc.). Preferred over Chrome for sites with bot detection.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        url: { type: 'string', description: 'URL to navigate to' },
        macro: {
          type: 'string',
          description: 'Search macro (e.g., @google_search, @youtube_search)',
          enum: SEARCH_MACROS,
        },
        query: { type: 'string', description: 'Search query (when using macro)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_scroll',
    description: 'Scroll a Camoufox page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Pixels to scroll' },
      },
      required: ['tabId', 'direction'],
    },
  },
  {
    name: 'camofox_screenshot',
    description: 'Take a screenshot of a Camoufox page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_close_tab',
    description: 'Close a Camoufox browser tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_evaluate',
    description:
      "Execute JavaScript in a Camoufox tab's page context. Returns the result of the expression. Use for injecting scripts, reading page state, or calling web app APIs.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        expression: {
          type: 'string',
          description: 'JavaScript expression to evaluate in the page context',
        },
      },
      required: ['tabId', 'expression'],
    },
  },
  {
    name: 'camofox_list_tabs',
    description: 'List all open Camofox tabs for the current session.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'camofox_import_cookies',
    description:
      'Import cookies into the current Camoufox session (Netscape cookie file). Use to authenticate to sites like LinkedIn without interactive login. Requires CAMOFOX_API_KEY on the REST server.',
    inputSchema: {
      type: 'object',
      properties: {
        cookiesPath: {
          type: 'string',
          description: 'Relative path to a Netscape-format cookies.txt file within the server cookies directory',
        },
        domainSuffix: {
          type: 'string',
          description: 'Only import cookies whose domain ends with this suffix',
        },
      },
      required: ['cookiesPath'],
    },
  },
];

/** Quick name → def lookup. */
export const TOOL_BY_NAME = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t]));

/** Tool names in canonical order. */
export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/**
 * Strip the routing key (tabId) from args, returning the REST body fields.
 * @param {Record<string, unknown>} args
 * @param {string} [dropKey]
 * @returns {Record<string, unknown>}
 */
function without(args, dropKey = 'tabId') {
  const { [dropKey]: _omit, ...rest } = args;
  return rest;
}

/**
 * Build a REST request spec for a tool. Pure / synchronous — except cookie
 * import, which needs async file parsing; use buildCookieRequest() for that.
 *
 * @param {string} name - Tool name.
 * @param {Record<string, unknown>} args - Tool arguments.
 * @param {CallContext} ctx - { userId, sessionKey }.
 * @returns {RequestSpec}
 * @throws {Error} if the tool is unknown.
 */
export function buildRequest(name, args, ctx) {
  const userId = ctx.userId;
  const sessionKey = ctx.sessionKey;
  switch (name) {
    case 'camofox_create_tab':
      return {
        method: 'POST',
        path: '/tabs',
        auth: 'accessKey',
        responseKind: 'json',
        body: { url: args.url, userId, sessionKey },
      };
    case 'camofox_snapshot': {
      const params = new URLSearchParams({ userId, includeScreenshot: 'true' });
      if (args.offset != null && args.offset !== '') params.set('offset', String(args.offset));
      return {
        method: 'GET',
        path: `/tabs/${args.tabId}/snapshot?${params}`,
        auth: 'accessKey',
        responseKind: 'snapshot',
      };
    }
    case 'camofox_click':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/click`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'camofox_type':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/type`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'camofox_navigate':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/navigate`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'camofox_scroll':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/scroll`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'camofox_screenshot':
      return {
        method: 'GET',
        path: `/tabs/${args.tabId}/screenshot?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'image',
      };
    case 'camofox_close_tab':
      return {
        method: 'DELETE',
        path: `/tabs/${args.tabId}?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'camofox_evaluate':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/evaluate`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { userId, expression: args.expression },
      };
    case 'camofox_list_tabs':
      return {
        method: 'GET',
        path: `/tabs?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'camofox_import_cookies':
      // Async (Netscape parse + path check) — caller must use buildCookieRequest().
      throw new Error('camofox_import_cookies requires buildCookieRequest() (async cookie parsing)');
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Cookie import is special: the Netscape file must be parsed locally (matching
 * the OpenClaw plugin) and the REST route accepts a parsed `{ cookies: [...] }`
 * body, never a path. This function does the parse and returns a request spec
 * that the host fetch layer can dispatch like any other tool.
 *
 * @param {{cookiesPath: string, domainSuffix?: string}} args
 * @param {CallContext} ctx
 * @param {{apiKey: string, cookiesDir: string}} config - server config (apiKey + cookiesDir).
 * @returns {Promise<RequestSpec & {meta: {imported: number, userId: string}}>}
 * @throws {Error} if CAMOFOX_API_KEY is unset.
 */
export async function buildCookieRequest(args, ctx, config) {
  if (!config.apiKey) {
    throw new Error(
      'CAMOFOX_API_KEY is not set. Cookie import is disabled unless both the server and the host (MCP/OpenClaw) have CAMOFOX_API_KEY.'
    );
  }
  const cookies = await readCookieFile({
    cookiesDir: config.cookiesDir,
    cookiesPath: args.cookiesPath,
    domainSuffix: args.domainSuffix,
  });
  return {
    method: 'POST',
    path: `/sessions/${encodeURIComponent(ctx.userId)}/cookies`,
    auth: 'apiKey',
    responseKind: 'json',
    body: { cookies },
    meta: { imported: cookies.length, userId: ctx.userId },
  };
}

/**
 * Resolve which bearer token a request needs, given server config.
 * @param {RequestSpec} spec
 * @param {{accessKey?: string, apiKey?: string}} config
 * @returns {{header?: {Authorization: string}, missing?: string}}
 */
export function authHeaders(spec, config) {
  if (spec.auth === 'accessKey') {
    if (!config.accessKey) return {}; // server not gated — no header needed
    return { Authorization: `Bearer ${config.accessKey}` };
  }
  if (spec.auth === 'apiKey') {
    // apiKey presence is enforced by buildCookieRequest(); here we only attach it.
    return { Authorization: `Bearer ${config.apiKey}` };
  }
  return {};
}

/**
 * Execute a request spec against a REST base URL. Shared by the MCP server and
 * the OpenClaw plugin so the wire-level behavior (auth headers, image decoding,
 * error formatting) is identical across hosts.
 *
 * @param {string} baseUrl - REST server origin (e.g. http://localhost:9377).
 * @param {RequestSpec} spec
 * @param {{accessKey?: string, apiKey?: string}} config
 * @returns {Promise<unknown>} JSON value, or an image content block for image specs.
 * @throws {Error} on non-2xx, or when an image route returns non-image bytes.
 */
export async function fetchSpec(baseUrl, spec, config) {
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders(spec, config),
  };
  const res = await fetch(`${baseUrl}${spec.path}`, {
    method: spec.method,
    headers,
    body: spec.body ? JSON.stringify(spec.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  if (spec.responseKind === 'image') {
    const contentType = res.headers.get('content-type') || '';
    // Guard: server may return JSON/text (e.g. error with 200) — don't base64 it.
    if (!contentType.startsWith('image/')) {
      const text = await res.text();
      throw new Error(`Screenshot failed: ${text}`);
    }
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    return { type: 'image', data, mimeType: contentType };
  }
  return res.json();
}

/**
 * Build + dispatch a tool call end-to-end. The single entry point both hosts
 * call, so a tool's full behavior (request shape + auth + transport + response
 * shaping) lives in exactly one place. Hosts only differ in how they source
 * `ctx` (userId/sessionKey) and `config`.
 *
 * @param {string} name - Tool name.
 * @param {Record<string, unknown>} args - Tool arguments.
 * @param {CallContext} ctx - { userId, sessionKey }.
 * @param {string} baseUrl - REST server origin.
 * @param {{apiKey?: string, accessKey?: string, cookiesDir: string}} config - server config.
 * @returns {Promise<{spec: RequestSpec, payload: unknown}>}
 */
export async function runTool(name, args, ctx, baseUrl, config) {
  const spec =
    name === 'camofox_import_cookies'
      ? await buildCookieRequest(args, ctx, config)
      : buildRequest(name, args, ctx);
  const payload = await fetchSpec(baseUrl, spec, config);
  return { spec, payload };
}

/**
 * Shape a REST JSON payload into MCP/OpenClaw content blocks.
 *
 * - snapshot: splits the embedded screenshot out as an image block
 * - image: already an image block produced by the fetch layer
 * - json (default): pretty-printed JSON text block
 *
 * @param {RequestSpec} spec
 * @param {unknown} payload - JSON value ('json'/'snapshot') or an image block ('image').
 * @returns {Array<{type: string, text?: string, data?: string, mimeType?: string}>}
 */
export function adaptResponse(spec, payload) {
  if (spec.responseKind === 'image') {
    return [payload];
  }
  if (spec.responseKind === 'snapshot') {
    const { screenshot, ...rest } = /** @type {any} */ (payload) || {};
    const content = [{ type: 'text', text: JSON.stringify(rest, null, 2) }];
    if (screenshot?.data) {
      content.push({
        type: 'image',
        data: screenshot.data,
        mimeType: screenshot.mimeType || 'image/png',
      });
    }
    return content;
  }
  // Cookie import: surface the parsed count alongside the server reply.
  if (spec.meta && spec.meta.imported != null) {
    return [
      {
        type: 'text',
        text: JSON.stringify({ imported: spec.meta.imported, userId: spec.meta.userId, result: payload }, null, 2),
      },
    ];
  }
  return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
}
