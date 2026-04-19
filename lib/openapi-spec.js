import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const userIdQuery = { name: 'userId', in: 'query', required: true, schema: { type: 'string' }, description: 'Session owner identifier.' };
const userIdBody = { type: 'string', description: 'Session owner identifier.' };
const tabIdPath = { name: 'tabId', in: 'path', required: true, schema: { type: 'string' }, description: 'Tab identifier returned by POST /tabs.' };

const errorResponse = { description: 'Error response.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const okResponse = { description: 'Success.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } } } };

export function buildOpenApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'camofox-browser',
      version: pkg.version,
      description: 'Anti-detection browser automation server for AI agents, powered by Camoufox. Accessibility snapshots, element refs, session isolation, cookie import, proxy + GeoIP, and structured logs.',
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
      contact: { name: 'Jo Inc', url: 'https://askjo.ai', email: 'oss@askjo.ai' },
    },
    servers: [
      { url: 'http://localhost:9377', description: 'Local development' },
    ],
    tags: [
      { name: 'System', description: 'Server health and metrics.' },
      { name: 'Tabs', description: 'Create, inspect, and destroy browser tabs.' },
      { name: 'Interaction', description: 'Click, type, scroll, and navigate within a tab.' },
      { name: 'Content', description: 'Accessibility snapshots, screenshots, links, images.' },
      { name: 'Sessions', description: 'Per-userId session state (cookies, teardown).' },
      { name: 'Browser', description: 'Global browser lifecycle (start, stop, restart).' },
      { name: 'Legacy', description: 'Pre-tabId endpoints kept for backward compatibility.' },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Bearer token matching CAMOFOX_API_KEY. Required for cookie import and other privileged operations.',
        },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
        Health: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            engine: { type: 'string', example: 'camoufox' },
            browserConnected: { type: 'boolean' },
            browserRunning: { type: 'boolean' },
            activeTabs: { type: 'integer' },
            activeSessions: { type: 'integer' },
            consecutiveFailures: { type: 'integer' },
          },
        },
        Tab: {
          type: 'object',
          properties: {
            tabId: { type: 'string' },
            url: { type: 'string' },
            title: { type: 'string' },
          },
        },
        TabCreate: {
          type: 'object',
          required: ['userId', 'sessionKey'],
          properties: {
            userId: userIdBody,
            sessionKey: { type: 'string', description: 'Tab group identifier (alias: listItemId).' },
            listItemId: { type: 'string', description: 'Legacy alias for sessionKey.' },
            url: { type: 'string', description: 'Optional initial URL.' },
          },
        },
        TabList: {
          type: 'object',
          properties: {
            running: { type: 'boolean' },
            tabs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  tabId: { type: 'string' },
                  targetId: { type: 'string' },
                  url: { type: 'string' },
                  title: { type: 'string' },
                  listItemId: { type: 'string' },
                },
              },
            },
          },
        },
        Snapshot: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            snapshot: { type: 'string', description: 'Accessibility tree with element refs e1, e2, ...' },
            refsCount: { type: 'integer' },
            totalChars: { type: 'integer' },
            truncated: { type: 'boolean' },
          },
        },
        Navigate: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: userIdBody,
            url: { type: 'string' },
            macro: { type: 'string', description: 'Search macro such as @google_search.' },
            query: { type: 'string' },
          },
        },
        Click: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: userIdBody,
            ref: { type: 'string', description: 'Element ref from the latest snapshot (e.g. "e1").' },
            selector: { type: 'string', description: 'CSS selector (alternative to ref).' },
          },
        },
        Type: {
          type: 'object',
          required: ['userId', 'text'],
          properties: {
            userId: userIdBody,
            ref: { type: 'string' },
            selector: { type: 'string' },
            text: { type: 'string' },
            pressEnter: { type: 'boolean' },
            mode: { type: 'string', enum: ['fill', 'keyboard'] },
          },
        },
        Press: {
          type: 'object',
          required: ['userId', 'key'],
          properties: {
            userId: userIdBody,
            key: { type: 'string', description: 'Playwright key name (e.g. Enter, Escape, Tab).' },
          },
        },
        Scroll: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: userIdBody,
            direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
            amount: { type: 'integer' },
          },
        },
        Wait: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: userIdBody,
            ms: { type: 'integer' },
            selector: { type: 'string' },
          },
        },
        Evaluate: {
          type: 'object',
          required: ['userId', 'expression'],
          properties: {
            userId: userIdBody,
            expression: { type: 'string', description: 'JavaScript expression to evaluate in page context.' },
          },
        },
        EvaluateResult: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, result: {} },
        },
        Links: {
          type: 'object',
          properties: {
            links: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, text: { type: 'string' } } } },
            pagination: {
              type: 'object',
              properties: {
                total: { type: 'integer' }, offset: { type: 'integer' },
                limit: { type: 'integer' }, hasMore: { type: 'boolean' },
              },
            },
          },
        },
        Images: {
          type: 'object',
          properties: {
            images: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  src: { type: 'string' }, alt: { type: 'string' },
                  inline: { type: 'string', description: 'Optional base64 data URL.' },
                },
              },
            },
          },
        },
        Downloads: {
          type: 'object',
          properties: {
            downloads: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' }, filename: { type: 'string' },
                  url: { type: 'string' }, sizeBytes: { type: 'integer' },
                  inline: { type: 'string', description: 'Optional base64 content.' },
                },
              },
            },
          },
        },
        Stats: {
          type: 'object',
          properties: {
            tabId: { type: 'string' }, sessionKey: { type: 'string' },
            listItemId: { type: 'string' }, url: { type: 'string' },
            visitedUrls: { type: 'array', items: { type: 'string' } },
            downloadsCount: { type: 'integer' },
            toolCalls: { type: 'integer' }, refsCount: { type: 'integer' },
          },
        },
        CookieImport: {
          type: 'object',
          required: ['cookies'],
          properties: {
            cookies: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'value', 'domain', 'path'],
                properties: {
                  name: { type: 'string' }, value: { type: 'string' },
                  domain: { type: 'string' }, path: { type: 'string' },
                  expires: { type: 'number' }, httpOnly: { type: 'boolean' },
                  secure: { type: 'boolean' }, sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] },
                },
              },
            },
          },
        },
        CookieImportResult: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, added: { type: 'integer' } },
        },
      },
    },
    paths: {
      '/openapi.json': {
        get: {
          tags: ['System'],
          summary: 'Machine-readable API description.',
          description: 'OpenAPI 3.0 document covering every core server route. Plugin routes (e.g. /youtube/transcript, /sessions/:userId/storage_state) are not included here — they depend on which bundled plugins are enabled.',
          responses: { 200: { description: 'OpenAPI document.', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/docs': {
        get: {
          tags: ['System'],
          summary: 'Self-contained HTML API viewer (Redoc).',
          description: 'Serves a minimal HTML page that renders /openapi.json using Redoc via CDN.',
          responses: { 200: { description: 'HTML page.', content: { 'text/html': { schema: { type: 'string' } } } } },
        },
      },
      '/': {
        get: {
          tags: ['System'],
          summary: 'Server status ping.',
          description: 'Lightweight status probe suitable for process supervisors.',
          responses: { 200: { description: 'Running.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } } },
        },
      },
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Health check.',
          description: 'Returns engine, browser connection state, and active session counts.',
          responses: { 200: { description: 'Healthy.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } } },
        },
      },
      '/metrics': {
        get: {
          tags: ['System'],
          summary: 'Prometheus metrics.',
          description: 'Disabled unless PROMETHEUS_ENABLED=1 is set at startup.',
          responses: {
            200: { description: 'Prometheus exposition format.', content: { 'text/plain': { schema: { type: 'string' } } } },
            404: errorResponse,
          },
        },
      },
      '/tabs': {
        get: {
          tags: ['Tabs'],
          summary: 'List active tabs.',
          parameters: [{ name: 'userId', in: 'query', required: false, schema: { type: 'string' } }],
          responses: { 200: { description: 'Tab list.', content: { 'application/json': { schema: { $ref: '#/components/schemas/TabList' } } } } },
        },
        post: {
          tags: ['Tabs'],
          summary: 'Create a tab.',
          description: 'Opens a new browser page for the given userId + sessionKey. Optional url navigates before returning.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TabCreate' } } } },
          responses: {
            200: { description: 'Tab created.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Tab' } } } },
            400: errorResponse, 429: errorResponse,
          },
        },
      },
      '/tabs/open': {
        post: {
          tags: ['Tabs'],
          summary: 'Alias for POST /tabs (OpenClaw format).',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TabCreate' } } } },
          responses: { 200: { description: 'Tab created.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Tab' } } } } },
        },
      },
      '/tabs/{tabId}': {
        delete: {
          tags: ['Tabs'],
          summary: 'Close a tab.',
          parameters: [tabIdPath, userIdQuery],
          responses: { 200: okResponse, 404: errorResponse },
        },
      },
      '/tabs/group/{listItemId}': {
        delete: {
          tags: ['Tabs'],
          summary: 'Close an entire tab group.',
          parameters: [
            { name: 'listItemId', in: 'path', required: true, schema: { type: 'string' } },
            userIdQuery,
          ],
          responses: { 200: okResponse },
        },
      },
      '/tabs/{tabId}/navigate': {
        post: {
          tags: ['Interaction'],
          summary: 'Navigate the tab to a URL or macro.',
          parameters: [tabIdPath],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Navigate' } } } },
          responses: {
            200: { description: 'Navigated.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, tabId: { type: 'string' }, url: { type: 'string' } } } } } },
            400: errorResponse, 404: errorResponse,
          },
        },
      },
      '/tabs/{tabId}/snapshot': {
        get: {
          tags: ['Content'],
          summary: 'Accessibility snapshot.',
          description: 'Returns a token-efficient accessibility tree with stable e1/e2/e3 refs. Optional base64 screenshot via screenshot=1.',
          parameters: [
            tabIdPath, userIdQuery,
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
            { name: 'screenshot', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1'] } },
          ],
          responses: { 200: { description: 'Snapshot.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Snapshot' } } } } },
        },
      },
      '/tabs/{tabId}/click': {
        post: {
          tags: ['Interaction'],
          summary: 'Click an element by ref or selector.',
          parameters: [tabIdPath],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Click' } } } },
          responses: { 200: okResponse, 400: errorResponse, 404: errorResponse },
        },
      },
      '/tabs/{tabId}/type': {
        post: {
          tags: ['Interaction'],
          summary: 'Type into a focused element.',
          parameters: [tabIdPath],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Type' } } } },
          responses: { 200: okResponse, 400: errorResponse },
        },
      },
      '/tabs/{tabId}/press': {
        post: {
          tags: ['Interaction'],
          summary: 'Press a keyboard key.',
          parameters: [tabIdPath],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Press' } } } },
          responses: { 200: okResponse },
        },
      },
      '/tabs/{tabId}/scroll': {
        post: {
          tags: ['Interaction'],
          summary: 'Scroll the page.',
          parameters: [tabIdPath],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Scroll' } } } },
          responses: { 200: okResponse },
        },
      },
      '/tabs/{tabId}/back': {
        post: { tags: ['Interaction'], summary: 'Navigate back.', parameters: [tabIdPath],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['userId'], properties: { userId: userIdBody } } } } },
          responses: { 200: okResponse } },
      },
      '/tabs/{tabId}/forward': {
        post: { tags: ['Interaction'], summary: 'Navigate forward.', parameters: [tabIdPath],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['userId'], properties: { userId: userIdBody } } } } },
          responses: { 200: okResponse } },
      },
      '/tabs/{tabId}/refresh': {
        post: { tags: ['Interaction'], summary: 'Refresh the page.', parameters: [tabIdPath],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['userId'], properties: { userId: userIdBody } } } } },
          responses: { 200: okResponse } },
      },
      '/tabs/{tabId}/wait': {
        post: { tags: ['Interaction'], summary: 'Wait for a duration or selector.', parameters: [tabIdPath],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Wait' } } } },
          responses: { 200: okResponse } },
      },
      '/tabs/{tabId}/links': {
        get: { tags: ['Content'], summary: 'Paginated list of links on the page.',
          parameters: [
            tabIdPath, userIdQuery,
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'Links.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Links' } } } } } },
      },
      '/tabs/{tabId}/images': {
        get: { tags: ['Content'], summary: 'List <img> elements with optional inlined data URLs.',
          parameters: [
            tabIdPath, userIdQuery,
            { name: 'inline', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1'] } },
          ],
          responses: { 200: { description: 'Images.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Images' } } } } } },
      },
      '/tabs/{tabId}/downloads': {
        get: { tags: ['Content'], summary: 'List captured downloads for a tab.',
          parameters: [
            tabIdPath, userIdQuery,
            { name: 'inline', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1'] } },
          ],
          responses: { 200: { description: 'Downloads.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Downloads' } } } } } },
      },
      '/tabs/{tabId}/screenshot': {
        get: { tags: ['Content'], summary: 'Full-viewport PNG screenshot.',
          parameters: [tabIdPath, userIdQuery],
          responses: { 200: { description: 'PNG bytes.', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } }, 404: errorResponse } },
      },
      '/tabs/{tabId}/stats': {
        get: { tags: ['Tabs'], summary: 'Per-tab operational stats.',
          parameters: [tabIdPath, userIdQuery],
          responses: { 200: { description: 'Stats.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Stats' } } } } } },
      },
      '/tabs/{tabId}/evaluate': {
        post: { tags: ['Interaction'], summary: 'Evaluate a JavaScript expression in page context.',
          parameters: [tabIdPath],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Evaluate' } } } },
          responses: { 200: { description: 'Evaluation result.', content: { 'application/json': { schema: { $ref: '#/components/schemas/EvaluateResult' } } } } } },
      },
      '/sessions/{userId}/cookies': {
        post: {
          tags: ['Sessions'],
          summary: 'Import cookies into the session.',
          description: 'Requires CAMOFOX_API_KEY to be set server-side and passed as Bearer token. Max 500 cookies, 5MB per request.',
          security: [{ BearerAuth: [] }],
          parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CookieImport' } } } },
          responses: {
            200: { description: 'Cookies imported.', content: { 'application/json': { schema: { $ref: '#/components/schemas/CookieImportResult' } } } },
            400: errorResponse, 403: errorResponse, 413: errorResponse,
          },
        },
      },
      '/sessions/{userId}': {
        delete: {
          tags: ['Sessions'],
          summary: 'Destroy the session and free all tabs.',
          parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: okResponse },
        },
      },
      '/start': {
        post: { tags: ['Browser'], summary: 'Start the browser eagerly (bypass lazy launch).',
          responses: { 200: okResponse } },
      },
      '/stop': {
        post: { tags: ['Browser'], summary: 'Stop the browser and close all sessions.',
          description: 'Requires CAMOFOX_ADMIN_KEY when set.',
          security: [{ BearerAuth: [] }],
          responses: { 200: okResponse, 403: errorResponse } },
      },
      '/navigate': {
        post: { tags: ['Legacy'], summary: 'Navigate the default tab (legacy).',
          description: 'Kept for backward compatibility with the pre-tabId API. Prefer POST /tabs/:tabId/navigate.',
          requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/Navigate' } } } },
          responses: { 200: okResponse } },
      },
      '/snapshot': {
        get: { tags: ['Legacy'], summary: 'Snapshot the default tab (legacy).',
          description: 'Kept for backward compatibility. Prefer GET /tabs/:tabId/snapshot.',
          responses: { 200: { description: 'Snapshot.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Snapshot' } } } } } },
      },
      '/act': {
        post: { tags: ['Legacy'], summary: 'Act on the default tab (legacy combined intent).',
          description: 'Kept for backward compatibility. Prefer atomic /tabs/:tabId/* endpoints.',
          responses: { 200: okResponse } },
      },
    },
  };
}

export const openApiSpec = buildOpenApiSpec();
