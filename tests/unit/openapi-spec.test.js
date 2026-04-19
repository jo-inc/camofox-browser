import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openApiSpec, buildOpenApiSpec } from '../../lib/openapi-spec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', '..', 'server.js');

function collectServerRoutes() {
  const source = fs.readFileSync(serverPath, 'utf8');
  const routeRe = /^app\.(get|post|put|delete|patch)\(['"]([^'"]+)['"]/gm;
  const routes = new Set();
  let match;
  while ((match = routeRe.exec(source)) !== null) {
    const method = match[1].toUpperCase();
    const routePath = match[2].replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
    routes.add(`${method} ${routePath}`);
  }
  return routes;
}

function collectSpecRoutes() {
  const routes = new Set();
  for (const [routePath, methods] of Object.entries(openApiSpec.paths)) {
    for (const method of Object.keys(methods)) {
      routes.add(`${method.toUpperCase()} ${routePath}`);
    }
  }
  return routes;
}

describe('openapi-spec', () => {
  test('every server.js route appears in the spec', () => {
    const serverRoutes = collectServerRoutes();
    const specRoutes = collectSpecRoutes();
    const missing = [...serverRoutes].filter(r => !specRoutes.has(r));
    expect({ missingFromSpec: missing }).toEqual({ missingFromSpec: [] });
  });

  test('no stale routes in the spec that are not in server.js', () => {
    const serverRoutes = collectServerRoutes();
    const specRoutes = collectSpecRoutes();
    const stale = [...specRoutes].filter(r => !serverRoutes.has(r));
    expect({ staleInSpec: stale }).toEqual({ staleInSpec: [] });
  });

  test('spec version reads from package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(openApiSpec.info.version).toBe(pkg.version);
  });

  test('spec is a valid OpenAPI 3.0.x object shape', () => {
    expect(openApiSpec.openapi).toMatch(/^3\.0\./);
    expect(openApiSpec.info.title).toBe('camofox-browser');
    expect(openApiSpec.servers.length).toBeGreaterThan(0);
    expect(Object.keys(openApiSpec.paths).length).toBeGreaterThan(20);
    expect(openApiSpec.components.schemas.Error).toBeDefined();
    expect(openApiSpec.components.securitySchemes.BearerAuth.scheme).toBe('bearer');
  });

  test('buildOpenApiSpec is pure (returns equivalent object each call)', () => {
    const a = buildOpenApiSpec();
    const b = buildOpenApiSpec();
    expect(a).toEqual(b);
  });

  test('every path operation has at least one response', () => {
    for (const [routePath, methods] of Object.entries(openApiSpec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        expect({ routePath, method, hasResponses: Object.keys(op.responses || {}).length > 0 })
          .toEqual({ routePath, method, hasResponses: true });
      }
    }
  });

  test('every request body $ref points to a defined schema', () => {
    const schemas = openApiSpec.components.schemas;
    for (const [routePath, methods] of Object.entries(openApiSpec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const content = op.requestBody?.content?.['application/json']?.schema;
        if (content?.$ref) {
          const refName = content.$ref.replace('#/components/schemas/', '');
          expect({ routePath, method, refName, defined: refName in schemas })
            .toEqual({ routePath, method, refName, defined: true });
        }
      }
    }
  });
});
