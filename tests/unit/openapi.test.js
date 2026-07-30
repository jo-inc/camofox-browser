/**
 * Tests for auto-generated OpenAPI spec.
 *
 * Verifies:
 *  1. Every server.js route appears in the spec (no drift)
 *  2. No stale routes in the spec that aren't in server.js
 *  3. Spec structure is valid OpenAPI 3.0.x
 *  4. info.version matches package.json
 *  5. Every operation has responses and tags
 *  6. Enriched routes have proper metadata
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildOpenApiSpec } from '../../lib/openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', '..', 'server.js');
const serverSrc = readFileSync(serverPath, 'utf8');
const pluginSources = [
  join(__dirname, '..', '..', 'plugins', 'persistence', 'index.js'),
  join(__dirname, '..', '..', 'plugins', 'vnc', 'index.js'),
  join(__dirname, '..', '..', 'plugins', 'youtube', 'index.js'),
].map(path => readFileSync(path, 'utf8'));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

// Build the same server + plugin route contract mounted at runtime.
const spec = buildOpenApiSpec();

/**
 * Extract all app.get/post/delete routes from server.js source.
 * Returns Set of "METHOD /path" strings (Express format with :params).
 */
function parseServerRoutes(source) {
  const routes = new Set();
  const re = /app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    routes.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return routes;
}

const serverRoutes = parseServerRoutes(serverSrc);
const runtimeRoutes = new Set([
  ...serverRoutes,
  ...pluginSources.flatMap(source => [...parseServerRoutes(source)]),
]);

describe('OpenAPI spec', () => {
  test('is valid OpenAPI 3.0.x shape', () => {
    expect(spec.openapi).toMatch(/^3\.0\.\d+$/);
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBe('camofox-browser');
    expect(spec.paths).toBeDefined();
    expect(typeof spec.paths).toBe('object');
    expect(spec.components).toBeDefined();
  });

  test('info.version matches package.json', () => {
    expect(spec.info.version).toBe(pkg.version);
  });

  test('every server and plugin route appears in the spec', () => {
    const missing = [];
    for (const route of runtimeRoutes) {
      const [method, expressPath] = route.split(' ');
      const oaPath = expressPath.replace(/:(\w+)/g, '{$1}');
      const pathObj = spec.paths[oaPath];
      if (!pathObj || !pathObj[method.toLowerCase()]) {
        missing.push(route);
      }
    }
    expect(missing).toEqual([]);
  });

  test('no stale routes in spec that are not registered by server or plugins', () => {
    const stale = [];
    for (const [oaPath, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        if (method.startsWith('x-')) continue; // skip extensions
        const expressPath = oaPath.replace(/\{(\w+)\}/g, ':$1');
        const key = `${method.toUpperCase()} ${expressPath}`;
        if (!runtimeRoutes.has(key)) {
          stale.push(key);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  test('spec covers at least 30 runtime routes', () => {
    expect(runtimeRoutes.size).toBeGreaterThanOrEqual(30);

    let covered = 0;
    for (const route of runtimeRoutes) {
      const [method, expressPath] = route.split(' ');
      const oaPath = expressPath.replace(/:(\w+)/g, '{$1}');
      if (spec.paths[oaPath]?.[method.toLowerCase()]) covered++;
    }
    expect(covered).toBe(runtimeRoutes.size);
  });

  test('every operation has at least one response', () => {
    const noResponses = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (method.startsWith('x-')) continue;
        if (!op.responses || Object.keys(op.responses).length === 0) {
          noResponses.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(noResponses).toEqual([]);
  });

  test('every operation has at least one tag', () => {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (method.startsWith('x-')) continue;
        expect(op.tags?.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test('parameterized routes have path parameters', () => {
    const navOp = spec.paths['/tabs/{tabId}/navigate']?.post;
    expect(navOp).toBeDefined();
    const tabIdParam = navOp.parameters?.find(p => p.name === 'tabId' && p.in === 'path');
    expect(tabIdParam).toBeDefined();
    expect(tabIdParam.required).toBe(true);
    expect(tabIdParam.schema.type).toBe('string');
  });

  test('POST /tabs has request body and proper tag', () => {
    const createTab = spec.paths['/tabs']?.post;
    expect(createTab).toBeDefined();
    expect(createTab.summary).toBe('Create a new tab');
    expect(createTab.tags).toContain('Tabs');
    expect(createTab.requestBody).toBeDefined();
    expect(createTab.requestBody.content['application/json']).toBeDefined();
  });

  test('session ownership fields are documented for create and cleanup', () => {
    const createSchema = spec.paths['/tabs'].post
      .requestBody.content['application/json'].schema;
    expect(createSchema.properties.exclusiveSession).toMatchObject({ type: 'boolean' });
    expect(createSchema.properties.sessionOwnerToken).toMatchObject({
      type: 'string',
      minLength: 32,
      maxLength: 256,
      writeOnly: true,
    });
    expect(spec.paths['/capabilities'].get.responses['200']
      .content['application/json'].schema.properties.atomicSessionOwnership
      .properties.ownerTokenHeader).toMatchObject({
      type: 'string',
      example: 'X-Camofox-Session-Owner',
    });
    expect(spec.paths['/tabs'].post.responses['200']
      .content['application/json'].schema.properties.sessionOwned).toMatchObject({
      type: 'boolean',
    });

    const deleteOperation = spec.paths['/sessions/{userId}'].delete;
    expect(deleteOperation.requestBody.content['application/json']
      .schema.properties.sessionOwnerToken.writeOnly).toBe(true);
    expect(deleteOperation.responses['200'].content['application/json']
      .schema.properties.claimReleased).toMatchObject({ type: 'boolean' });
    expect(deleteOperation.responses['400'].description).toContain('Invalid or conflicting');
    expect(deleteOperation.responses['409'].description).toContain('creation is still in flight');
  });

  test('legacy routes are marked deprecated', () => {
    const legacyPaths = {
      '/act': 'post',
      '/navigate': 'post',
      '/snapshot': 'get',
      '/tabs/open': 'post',
    };
    for (const [path, method] of Object.entries(legacyPaths)) {
      const op = spec.paths[path]?.[method];
      expect(op).toBeDefined();
      expect(op.deprecated).toBe(true);
    }
  });

  test('Error schema is defined in components', () => {
    expect(spec.components.schemas.Error).toBeDefined();
    expect(spec.components.schemas.Error.required).toContain('error');
  });

  test('tags include well-known categories', () => {
    const tagNames = spec.tags.map(t => t.name);
    for (const expected of ['System', 'Tabs', 'Navigation', 'Interaction', 'Content', 'Sessions', 'Legacy', 'Browser']) {
      expect(tagNames).toContain(expected);
    }
  });

  test('security scheme BearerAuth is defined', () => {
    expect(spec.components.securitySchemes.BearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.BearerAuth.type).toBe('http');
    expect(spec.components.securitySchemes.BearerAuth.scheme).toBe('bearer');
  });

  test('POST /stop documents its runtime x-admin-key authentication', () => {
    const scheme = spec.components.securitySchemes.AdminKey;
    expect(scheme).toMatchObject({ type: 'apiKey', in: 'header', name: 'x-admin-key' });
    expect(spec.paths['/stop']?.post?.security).toEqual([{ AdminKey: [] }]);
  });

  test('user-scoped control operations document owner header and ownership errors', () => {
    expect(spec.components.parameters.SessionOwnerTokenHeader).toMatchObject({
      name: 'X-Camofox-Session-Owner',
      in: 'header',
      required: false,
      schema: { type: 'string', minLength: 32, maxLength: 256 },
    });
    const operations = [
      spec.paths['/tabs'].post,
      spec.paths['/tabs/{tabId}/snapshot'].get,
      spec.paths['/tabs/open'].post,
      spec.paths['/sessions/{userId}/cookies'].post,
      spec.paths['/sessions/{userId}/traces'].get,
      spec.paths['/sessions/{userId}/storage_state'].get,
      spec.paths['/sessions/{userId}/storage_state'].delete,
      spec.paths['/sessions/{userId}'].delete,
      spec.paths['/navigate'].post,
      spec.paths['/snapshot'].get,
      spec.paths['/act'].post,
    ];
    for (const operation of operations) {
      expect(operation.parameters).toContainEqual({
        $ref: '#/components/parameters/SessionOwnerTokenHeader',
      });
      expect(operation.responses['400']).toBeDefined();
      expect(operation.responses['403']).toBeDefined();
      expect(operation.responses['409']).toBeDefined();
    }
  });

  test('cookie import route has security requirement', () => {
    const op = spec.paths['/sessions/{userId}/cookies']?.post;
    expect(op).toBeDefined();
    expect(op.security).toEqual([{ BearerAuth: [] }]);
  });

  test('GET /tabs documents its required session identity', () => {
    const parameter = spec.paths['/tabs'].get.parameters
      .find(item => item.name === 'userId' && item.in === 'query');
    expect(parameter).toMatchObject({ required: true, schema: { type: 'string' } });
  });

  test('$ref references resolve to existing component schemas', () => {
    const schemaNames = Object.keys(spec.components?.schemas || {});
    const refs = [];
    JSON.stringify(spec, (key, val) => {
      if (key === '$ref' && typeof val === 'string') refs.push(val);
      return val;
    });

    const unresolved = refs.filter(ref => {
      const match = ref.match(/^#\/components\/schemas\/(.+)$/);
      return match && !schemaNames.includes(match[1]);
    });
    expect(unresolved).toEqual([]);
  });

  test('root and docs OpenAPI snapshots are up to date', () => {
    for (const relativePath of ['openapi.json', join('docs', 'openapi.json')]) {
      let committed;
      try {
        committed = JSON.parse(readFileSync(join(__dirname, '..', '..', relativePath), 'utf8'));
      } catch {
        throw new Error(`${relativePath} not found -- run: npm run generate-openapi`);
      }
      expect(committed).toEqual(spec);
    }
  });
});
