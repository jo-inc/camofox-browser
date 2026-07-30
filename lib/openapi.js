/**
 * OpenAPI spec generation via swagger-jsdoc + docs UI (swagger-stripey).
 *
 * swagger-jsdoc scans JSDoc `@openapi` comments on route handlers in server.js
 * (and any file passed in `apis`) to build the spec at startup.
 * Docs UI lives in docs/api.html (swagger-stripey: Stripe-style 3-panel renderer).
 *
 * Usage:
 *   import { mountDocs } from './lib/openapi.js';
 *   // After all routes are registered:
 *   mountDocs(app);
 */

import swaggerJsdoc from 'swagger-jsdoc';
import express from 'express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OPENAPI_APIS = [
  join(__dirname, '..', 'server.js'),
  join(__dirname, '..', 'plugins', '**', '*.js'),
];

let version = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  version = pkg.version;
} catch { /* ignore */ }

const swaggerDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'camofox-browser',
    version,
    description:
      'Anti-detection browser automation server for AI agents. ' +
      'Accessibility snapshots, element refs, session isolation, cookie import, proxy rotation, and structured logs.',
    license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    contact: { name: 'Jo Inc', url: 'https://askjo.ai', email: 'oss@askjo.ai' },
  },
  servers: [{ url: 'http://localhost:9377', description: 'Local development' }],
  tags: [
    { name: 'System', description: 'Server health, metrics, and status.' },
    { name: 'Tabs', description: 'Create, list, inspect, and destroy browser tabs.' },
    { name: 'Navigation', description: 'Navigate tabs to URLs or via search macros.' },
    { name: 'Interaction', description: 'Click, type, scroll, press keys, evaluate JS.' },
    { name: 'Content', description: 'Accessibility snapshots, screenshots, links, images, downloads.' },
    { name: 'Sessions', description: 'Per-user session state: cookies, teardown.' },
    { name: 'Browser', description: 'Global browser lifecycle (start/stop).' },
    { name: 'Legacy', description: 'OpenClaw-compatible endpoints (deprecated).' },
  ],
  components: {
    parameters: {
      SessionOwnerTokenHeader: {
        name: 'X-Camofox-Session-Owner',
        in: 'header',
        required: false,
        description: 'Exact owner token required for every control request after a session has been claimed. Never send this token in a query string.',
        schema: {
          type: 'string',
          minLength: 32,
          maxLength: 256,
          pattern: '^[A-Za-z0-9_-]+$',
        },
      },
    },
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Bearer token matching CAMOFOX_API_KEY (per-route auth for sensitive endpoints like cookie import and traces).',
      },
      AdminKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-key',
        description: 'Administrative key matching CAMOFOX_ADMIN_KEY. Required by POST /stop.',
      },
      AccessKeyAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Bearer token matching CAMOFOX_ACCESS_KEY. When set, gates all routes except /health, cookie import, and /stop. Acts as a superkey -- also accepted by endpoints that normally require CAMOFOX_API_KEY.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
      },
    },
  },
};

const USER_SCOPED_LEGACY_PATHS = new Set(['/navigate', '/snapshot', '/act']);

function isUserScopedControlPath(path) {
  return path === '/tabs' || path.startsWith('/tabs/') ||
    path.startsWith('/sessions/{userId}') || USER_SCOPED_LEGACY_PATHS.has(path);
}

/** Add the ownership contract consistently to every user-scoped control operation. */
export function applySessionOwnershipContract(spec) {
  const ownershipParameter = { $ref: '#/components/parameters/SessionOwnerTokenHeader' };
  const ownershipResponses = {
    400: {
      description: 'Invalid or conflicting session owner token or user identifier.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
    403: {
      description: 'The claimed session requires its exact owner token.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
    409: {
      description: 'Session ownership, creation, or deletion lifecycle conflict.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  };
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!isUserScopedControlPath(path)) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation) continue;
      operation.parameters ||= [];
      if (!operation.parameters.some(parameter => parameter.$ref === ownershipParameter.$ref)) {
        operation.parameters.push(ownershipParameter);
      }
      operation.responses ||= {};
      for (const [status, response] of Object.entries(ownershipResponses)) {
        operation.responses[status] ||= response;
      }
    }
  }
  return spec;
}

export function buildOpenApiSpec(apis = DEFAULT_OPENAPI_APIS) {
  return applySessionOwnershipContract(swaggerJsdoc({
    definition: swaggerDefinition,
    apis,
  }));
}

/**
 * Mount GET /openapi.json and GET /docs on the Express app.
 * Call AFTER all routes are registered so swagger-jsdoc can scan them.
 *
 * @param {import('express').Application} app
 * @param {Object} [opts]
 * @param {string[]} [opts.apis] - Glob patterns for files with @openapi JSDoc
 */
export function mountDocs(app, opts = {}) {
  const apis = opts.apis || DEFAULT_OPENAPI_APIS;
  const spec = buildOpenApiSpec(apis);

  app.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });

  // Serve docs static assets (api.html, fox.png, openapi.json)
  const docsDir = join(__dirname, '..', 'docs');
  app.use('/docs', express.static(docsDir, { index: 'api.html' }));

  // Also serve fox.png at root for backward compat with old Swagger UI HTML
  app.get('/fox.png', (_req, res) => {
    res.sendFile(join(docsDir, 'fox.png'));
  });

  return spec;
}

export { swaggerDefinition };
