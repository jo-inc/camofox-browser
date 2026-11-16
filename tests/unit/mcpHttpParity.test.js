import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOL_NAMES, buildRequest } from '../../mcp/lib/tool-contracts.mjs';

/**
 * HTTP <-> MCP parity gate.
 *
 * Every browser action that an agent can reach over HTTP should also be
 * reachable as an MCP/OpenClaw tool, so the two hosts never drift. This test
 * forces that decision to be explicit: every route in openapi.json must be
 * either (a) covered by an MCP tool, or (b) listed below as intentionally
 * HTTP-only with a reason. A new route added without doing one of those two
 * things fails this test.
 *
 * INFRA_HTTP_ONLY  — operational/admin/debug endpoints that are not agent
 *   "tools" (health, metrics, server start/stop, session admin, traces,
 *   file streaming, deprecated legacy aliases). These are not expected to
 *   have MCP parity.
 *
 * TOOL_BACKLOG_HTTP_ONLY — browser-action endpoints that SHOULD reach MCP
 *   parity but predate the shared contract and are out of scope for this
 *   release. This list is the visible parity debt: shrink it, don't grow it.
 *   Anything new and tool-like must go to the MCP contract, not here.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const openapi = JSON.parse(readFileSync(join(__dirname, '../../openapi.json'), 'utf8'));
const plugin = JSON.parse(readFileSync(join(__dirname, '../../openclaw.plugin.json'), 'utf8'));

// Operational / non-tool endpoints — no MCP parity expected.
const INFRA_HTTP_ONLY = new Set([
  'GET /',
  'GET /health',
  'GET /metrics',
  'POST /start',
  'POST /stop',
  'POST /pressure/cleanup',
  'DELETE /sessions/{userId}',
  'GET /sessions/{userId}/traces',
  'GET /sessions/{userId}/traces/{filename}',
  'DELETE /sessions/{userId}/traces/{filename}',
  'GET /tabs/{tabId}/downloads',
  'GET /tabs/{tabId}/downloads/{downloadId}/content',
  'POST /tabs/{tabId}/fetch-current-resource',
  'GET /tabs/{tabId}/stats',
  'DELETE /tabs/group/{listItemId}',
  // Deprecated legacy aliases kept only for backward compatibility.
  'POST /act',
  'POST /navigate',
  'GET /snapshot',
  'POST /tabs/open',
]);

// Browser-action endpoints that predate the shared contract. Known parity
// debt: these should become MCP tools over time. Do not add to this list.
const TOOL_BACKLOG_HTTP_ONLY = new Set([
  // Empty: every tool-like browser action now has MCP parity. If you add a
  // new browser action to HTTP, give it an MCP tool rather than listing it
  // here.
]);

// Sentinels that survive encodeURIComponent/URLSearchParams unchanged, so the
// path templates come back out of buildRequest intact.
const ARGS = {
  tabId: 'TABID',
  tableId: 'TABLEID',
  url: 'https://x.com',
  direction: 'down',
  expression: '1',
  script: 's',
  text: 'hi',
  path: '/u/a.pdf',
  start: { x: 1, y: 2 },
  end: { x: 3, y: 4 },
  origins: [{ origin: 'https://x.com', localStorage: [{ name: 'a', value: 'b' }] }],
};
const CTX = { userId: 'USERID', sessionKey: 'default' };

function templatize(path) {
  return path
    .split('?')[0]
    .replace(/TABLEID/g, '{tableId}')
    .replace(/USERID/g, '{userId}')
    .replace(/TABID/g, '{tabId}');
}

// Paths MCP can reach, as "METHOD /templated/path".
function mcpReachable() {
  const out = new Set();
  for (const name of TOOL_NAMES) {
    let spec;
    if (name === 'camofox_import_cookies') {
      // Async cookie builder — its route is fixed and known.
      spec = { method: 'POST', path: `/sessions/${CTX.userId}/cookies` };
    } else {
      spec = buildRequest(name, ARGS, CTX);
    }
    out.add(`${spec.method} ${templatize(spec.path)}`);
  }
  return out;
}

const OPENAPI_OPS = (() => {
  const ops = new Set();
  for (const [p, methods] of Object.entries(openapi.paths)) {
    for (const m of Object.keys(methods)) ops.add(`${m.toUpperCase()} ${p}`);
  }
  return ops;
})();

describe('HTTP <-> MCP parity gate', () => {
  const mcp = mcpReachable();

  test('every MCP tool points at a real documented route', () => {
    const dangling = [...mcp].filter((op) => !OPENAPI_OPS.has(op));
    expect(dangling).toEqual([]);
  });

  test('every HTTP route is classified: MCP-exposed, infra, or known backlog', () => {
    const unclassified = [...OPENAPI_OPS].filter(
      (op) => !mcp.has(op) && !INFRA_HTTP_ONLY.has(op) && !TOOL_BACKLOG_HTTP_ONLY.has(op)
    );
    // A new route must either get an MCP tool or be added to an allowlist
    // with a reason. If this fails, make the parity decision explicitly.
    expect(unclassified).toEqual([]);
  });

  test('allowlists do not shadow routes that are already MCP-exposed', () => {
    const overlap = [...mcp].filter(
      (op) => INFRA_HTTP_ONLY.has(op) || TOOL_BACKLOG_HTTP_ONLY.has(op)
    );
    expect(overlap).toEqual([]);
  });

  test('allowlisted routes still exist in the API (no stale entries)', () => {
    const stale = [...INFRA_HTTP_ONLY, ...TOOL_BACKLOG_HTTP_ONLY].filter((op) => !OPENAPI_OPS.has(op));
    expect(stale).toEqual([]);
  });

  test('OpenClaw plugin manifest lists exactly the shared tool set', () => {
    expect([...plugin.contracts.tools].sort()).toEqual([...TOOL_NAMES].sort());
  });
});
