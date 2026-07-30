#!/usr/bin/env node

/**
 * Generate openapi.json from JSDoc annotations in server.js.
 * Run: node scripts/generate-openapi.js
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildOpenApiSpec } from '../lib/openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const spec = buildOpenApiSpec();

const serialized = JSON.stringify(spec, null, 2) + '\n';
for (const out of [join(root, 'openapi.json'), join(root, 'docs', 'openapi.json')]) {
  writeFileSync(out, serialized);
}
console.log(`Wrote ${Object.keys(spec.paths).length} paths to root and docs OpenAPI files`);
