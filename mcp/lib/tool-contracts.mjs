/**
 * Canonical tool contracts for the camofox-browser REST API.
 *
 * Single source of truth shared by two hosts that expose the same 31 tools:
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

import { readCookieFile } from './cookies.mjs';

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
 * The 31 tools, identical schema for both hosts. Edit here and both update.
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
        annotateScreenshot: {
          type: 'boolean',
          description: 'Include screenshotAnnotations: per-ref bounding boxes aligned with the screenshot pixel space, for coordinate clicking (default false).',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_click',
    description:
      'Click an element in a Camoufox tab by ref (e.g., e1), CSS selector, or exact {x, y} coordinates. ' +
      'Coordinates pair with the screenshotAnnotations from camofox_snapshot. ' +
      'Optionally pass expected_role and/or expected_accessible_name to assert the target is still the element you expected before the click lands.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        ref: { type: 'string', description: 'Element ref from snapshot (e.g., e1)' },
        selector: { type: 'string', description: 'CSS selector (alternative to ref)' },
        coordinates: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          description: 'Exact viewport pixel coordinates (alternative to ref/selector)',
        },
        expected_role: {
          type: 'string',
          description: 'Assert the resolved target has this ARIA role before clicking',
        },
        expected_accessible_name: {
          type: 'string',
          description: 'Assert the resolved target has this accessible name before clicking',
        },
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
    name: 'camofox_upload',
    description:
      'Attach files to a file upload control in a Camoufox tab without the native OS file dialog. ' +
      'Each path must be an absolute path inside the server upload directory (CAMOFOX_UPLOADS_DIR, default ~/.camofox/uploads). ' +
      'Pass the upload trigger ref or selector from a snapshot; it may be omitted when the page already has an <input type="file">.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        path: {
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Absolute file path, or array of paths, inside CAMOFOX_UPLOADS_DIR',
        },
        ref: { type: 'string', description: 'Upload trigger element ref from snapshot (e.g., e36)' },
        selector: { type: 'string', description: 'Upload trigger CSS selector (alternative to ref)' },
        timeout: {
          type: 'number',
          description: 'Milliseconds to wait for the upload input or file chooser to appear after the trigger (default 12000)',
        },
      },
      required: ['tabId', 'path'],
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
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of the viewport (default false)',
        },
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
        timeoutMs: {
          type: 'number',
          description:
            'Evaluate deadline in ms (1000 to 900000, default 30000). Over 30000 the script runs as a server job and this call waits for it. On timeout the tab is kept.',
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
    name: 'camofox_activate',
    description: 'Bring a Camoufox tab to the front (focus/activate it).',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab identifier' } },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_ax',
    description:
      'Get the raw accessibility tree of a Camoufox page (unfiltered, no element refs). Use camofox_snapshot for interaction; use this to inspect the full ARIA structure.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab identifier' } },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_actionables',
    description:
      'List the clickable and fillable elements on a Camoufox page as candidate interaction targets, each with its ref.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        limit: { type: 'number', description: 'Maximum candidates to return (default 200)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_table_rows',
    description:
      'Read one page of rows from a table on a Camoufox page. Table ids come from camofox_snapshot (table.id or positional table-N). Use offset/limit to page through large tables.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        tableId: { type: 'string', description: 'Table id from a snapshot (e.g., table-0)' },
        offset: { type: 'number', description: 'Row offset to start from (default 0)' },
        limit: { type: 'number', description: 'Maximum rows to return' },
      },
      required: ['tabId', 'tableId'],
    },
  },
  {
    name: 'camofox_mouse_wheel',
    description:
      'Send a mouse wheel scroll over a specific element (by ref) or coordinate in a Camoufox tab. Unlike camofox_scroll (which scrolls the page), this wheels over nested scrollable containers and hover menus.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        ref: { type: 'string', description: 'Element ref to wheel over (from snapshot)' },
        x: { type: 'number', description: 'X coordinate to wheel over (with y; alternative to ref)' },
        y: { type: 'number', description: 'Y coordinate to wheel over (with x; alternative to ref)' },
        deltaX: { type: 'number', description: 'Horizontal wheel delta' },
        deltaY: { type: 'number', description: 'Vertical wheel delta' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_drag',
    description:
      'Perform a trusted press-move-release mouse drag between two coordinates in a Camoufox tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        start: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          description: 'Start point',
        },
        end: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
          description: 'End point',
        },
        steps: { type: 'number', description: 'Intermediate move steps (default 20)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' },
      },
      required: ['tabId', 'start', 'end'],
    },
  },
  {
    name: 'camofox_init_script',
    description:
      'Register a script that runs in the page context before every subsequent navigation in a Camoufox tab. Use to install fetch/XHR hooks that must catch the first request after a reload. Scripts accumulate and are dropped when the tab closes. Runs arbitrary JS, like camofox_evaluate.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        script: { type: 'string', description: 'JavaScript source to run before each navigation' },
      },
      required: ['tabId', 'script'],
    },
  },
  {
    name: 'camofox_export_storage_state',
    description:
      'Export the current session cookies and storage state (Playwright storageState format) for the current user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'camofox_import_local_storage',
    description:
      'Seed localStorage for one or more HTTP(S) origins in the current session. Each origin entry has { origin, localStorage: [{ name, value }] }.',
    inputSchema: {
      type: 'object',
      properties: {
        origins: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              origin: { type: 'string', description: 'HTTP or HTTPS origin, e.g. https://example.com' },
              localStorage: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { name: { type: 'string' }, value: { type: 'string' } },
                  required: ['name', 'value'],
                },
              },
            },
            required: ['origin', 'localStorage'],
          },
        },
      },
      required: ['origins'],
    },
  },
  {
    name: 'camofox_back',
    description: 'Go back one entry in a Camoufox tab\'s history.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab identifier' } },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_forward',
    description: 'Go forward one entry in a Camoufox tab\'s history.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab identifier' } },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_refresh',
    description: 'Reload the current page in a Camoufox tab.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab identifier' } },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_press',
    description:
      'Press a single keyboard key in a Camoufox tab (e.g., Enter, Escape, Tab, ArrowDown). Use camofox_type to enter text.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        key: { type: 'string', description: 'Key name, e.g. Enter, Escape, Tab, ArrowDown' },
      },
      required: ['tabId', 'key'],
    },
  },
  {
    name: 'camofox_select',
    description:
      'Choose an option in a native <select> dropdown in a Camoufox tab, by ref or CSS selector. The option is matched by value or visible label.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        ref: { type: 'string', description: 'Select element ref from snapshot' },
        selector: { type: 'string', description: 'CSS selector (alternative to ref)' },
        option: { type: 'string', description: 'Option value or visible label to select' },
      },
      required: ['tabId', 'option'],
    },
  },
  {
    name: 'camofox_viewport',
    description: 'Set the viewport (window) size of a Camoufox tab in pixels.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        width: { type: 'number', description: 'Viewport width in pixels' },
        height: { type: 'number', description: 'Viewport height in pixels' },
      },
      required: ['tabId', 'width', 'height'],
    },
  },
  {
    name: 'camofox_wait',
    description:
      'Wait for a Camoufox page to settle before continuing: up to timeout ms, optionally until the network is idle, optionally dismissing a consent dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        timeout: { type: 'number', description: 'Maximum milliseconds to wait (default 10000)' },
        waitForNetwork: { type: 'boolean', description: 'Wait for network idle (default true)' },
        dismissConsent: { type: 'boolean', description: 'Attempt to dismiss a cookie/consent dialog (default false)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_extract',
    description:
      'Extract structured data from a Camoufox page using a JSON Schema describing the fields to pull out. Returns data matching the schema.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        schema: { type: 'object', description: 'JSON Schema describing the data to extract' },
      },
      required: ['tabId', 'schema'],
    },
  },
  {
    name: 'camofox_links',
    description: 'List the links on a Camoufox page, with pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        limit: { type: 'number', description: 'Maximum links to return (default 50)' },
        offset: { type: 'number', description: 'Offset to start from (default 0)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'camofox_images',
    description:
      'List the images on a Camoufox page. Optionally inline the image bytes (base64) up to a byte cap.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        limit: { type: 'number', description: 'Maximum images to return (default 8, max 20)' },
        includeData: { type: 'boolean', description: 'Inline base64 image bytes (default false)' },
        maxBytes: { type: 'number', description: 'Per-image byte cap when includeData is true' },
      },
      required: ['tabId'],
    },
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

// Optional per-call profile, so one host can reach tabs opened under another userId.
for (const def of TOOL_DEFS) {
  Object.assign(def.inputSchema.properties, {
    userId: { type: 'string', description: "Camofox profile that owns the tab (default: this host's userId; others must be listed in CAMOFOX_MCP_USER_IDS)" },
    sessionKey: { type: 'string', description: "Tab group within the profile, used when creating a tab (default: this host's sessionKey)" },
  });
}

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
      if (args.annotateScreenshot === true || args.annotateScreenshot === 'true') params.set('annotateScreenshot', 'true');
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
    case 'camofox_upload':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/upload`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'camofox_screenshot': {
      const params = new URLSearchParams({ userId });
      if (args.fullPage === true || args.fullPage === 'true') params.set('fullPage', 'true');
      return {
        method: 'GET',
        path: `/tabs/${args.tabId}/screenshot?${params}`,
        auth: 'accessKey',
        responseKind: 'image',
      };
    }
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
        body: { userId, expression: args.expression, ...(args.timeoutMs != null ? { timeoutMs: args.timeoutMs } : {}) },
      };
    case 'camofox_activate':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/activate`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { userId },
      };
    case 'camofox_ax':
      return {
        method: 'GET',
        path: `/tabs/${args.tabId}/ax?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'camofox_actionables': {
      const params = new URLSearchParams({ userId });
      if (args.limit != null && args.limit !== '') params.set('limit', String(args.limit));
      return {
        method: 'GET',
        path: `/tabs/${args.tabId}/actionables?${params}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    }
    case 'camofox_table_rows': {
      const params = new URLSearchParams({ userId });
      if (args.offset != null && args.offset !== '') params.set('offset', String(args.offset));
      if (args.limit != null && args.limit !== '') params.set('limit', String(args.limit));
      return {
        method: 'GET',
        path: `/tabs/${args.tabId}/tables/${encodeURIComponent(args.tableId)}/rows?${params}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    }
    case 'camofox_mouse_wheel':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/mouse-wheel`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'camofox_drag':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/drag`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'camofox_init_script':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/init-script`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { userId, script: args.script },
      };
    case 'camofox_export_storage_state':
      return {
        method: 'GET',
        path: `/sessions/${encodeURIComponent(userId)}/storage_state`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'camofox_import_local_storage':
      return {
        method: 'POST',
        path: `/sessions/${encodeURIComponent(userId)}/local-storage`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { origins: args.origins },
      };
    case 'camofox_back':
      return { method: 'POST', path: `/tabs/${args.tabId}/back`, auth: 'accessKey', responseKind: 'json', body: { userId } };
    case 'camofox_forward':
      return { method: 'POST', path: `/tabs/${args.tabId}/forward`, auth: 'accessKey', responseKind: 'json', body: { userId } };
    case 'camofox_refresh':
      return { method: 'POST', path: `/tabs/${args.tabId}/refresh`, auth: 'accessKey', responseKind: 'json', body: { userId } };
    case 'camofox_press':
      return { method: 'POST', path: `/tabs/${args.tabId}/press`, auth: 'accessKey', responseKind: 'json', body: { userId, key: args.key } };
    case 'camofox_select':
      return { method: 'POST', path: `/tabs/${args.tabId}/select`, auth: 'accessKey', responseKind: 'json', body: { ...without(args), userId } };
    case 'camofox_viewport':
      return { method: 'POST', path: `/tabs/${args.tabId}/viewport`, auth: 'accessKey', responseKind: 'json', body: { userId, width: args.width, height: args.height } };
    case 'camofox_wait':
      return { method: 'POST', path: `/tabs/${args.tabId}/wait`, auth: 'accessKey', responseKind: 'json', body: { ...without(args), userId } };
    case 'camofox_extract':
      return { method: 'POST', path: `/tabs/${args.tabId}/extract`, auth: 'accessKey', responseKind: 'json', body: { userId, schema: args.schema } };
    case 'camofox_links': {
      const params = new URLSearchParams({ userId });
      if (args.limit != null && args.limit !== '') params.set('limit', String(args.limit));
      if (args.offset != null && args.offset !== '') params.set('offset', String(args.offset));
      return { method: 'GET', path: `/tabs/${args.tabId}/links?${params}`, auth: 'accessKey', responseKind: 'json' };
    }
    case 'camofox_images': {
      const params = new URLSearchParams({ userId });
      if (args.limit != null && args.limit !== '') params.set('limit', String(args.limit));
      if (args.includeData === true || args.includeData === 'true') params.set('includeData', 'true');
      if (args.maxBytes != null && args.maxBytes !== '') params.set('maxBytes', String(args.maxBytes));
      return { method: 'GET', path: `/tabs/${args.tabId}/images?${params}`, auth: 'accessKey', responseKind: 'json' };
    }
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
  const { userId, sessionKey, ...rest } = args;
  // A profile is a signed-in identity, so a host reaches only the ones its operator listed.
  if (userId && userId !== ctx.userId && !(config.allowedUserIds || []).includes(userId)) {
    throw new Error(`userId "${userId}" is not in CAMOFOX_MCP_USER_IDS`);
  }
  ctx = { userId: userId || ctx.userId, sessionKey: sessionKey || ctx.sessionKey };
  args = rest;
  if (name === 'camofox_evaluate' && args.timeoutMs > 30000) return runEvaluateJob(args, ctx, baseUrl, config);
  const spec =
    name === 'camofox_import_cookies'
      ? await buildCookieRequest(args, ctx, config)
      : buildRequest(name, args, ctx);
  const payload = await fetchSpec(baseUrl, spec, config);
  return { spec, payload };
}

/**
 * A long evaluate runs as a server job read back in short waits: Node fetch drops a response
 * slower than 300 s. A server without jobs answers the start request synchronously instead.
 */
async function runEvaluateJob(args, ctx, baseUrl, config) {
  const spec = buildRequest('camofox_evaluate', args, ctx);
  spec.body.async = true;
  let payload = await fetchSpec(baseUrl, spec, config);
  while (payload?.jobId && payload.state === 'running') {
    const params = new URLSearchParams({ userId: ctx.userId, waitMs: '60000' });
    payload = await fetchSpec(baseUrl, {
      method: 'GET',
      path: `/tabs/${args.tabId}/evaluate/${payload.jobId}?${params}`,
      auth: 'accessKey',
      responseKind: 'json',
    }, config);
  }
  if (payload?.jobId && payload.state !== 'done') {
    throw new Error(`${payload.state === 'timeout' ? 504 : 500}: ${JSON.stringify(payload)}`);
  }
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
