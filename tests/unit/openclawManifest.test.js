import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import { TOOL_NAMES } from '../../lib/mcp-tool-contracts.mjs';

// OpenClaw's manifest schema accepts tool ownership through contracts.tools. The
// package metadata mirrors it for package consumers; the legacy top-level tools
// field is intentionally absent because current OpenClaw rejects it.

function readJson(rel) {
  return JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
}

describe('OpenClaw manifest', () => {
  test('pins the tested OpenClaw plugin API version in package metadata', () => {
    const pkg = readJson('package.json');

    expect(pkg.openclaw.extensions).toEqual(['plugin.js']);
    expect(pkg.openclaw.runtimeExtensions).toEqual(['plugin.js']);
    expect(pkg.openclaw.compat.pluginApi).toBe('>=2026.9.4');
    expect(pkg.openclaw.build.openclawVersion).toBe('2026.9.4');
  });
  test('ships the compiled plugin entrypoint and no development script directory', () => {
    const pkg = readJson('package.json');

    expect(pkg.openclaw.extensions).toEqual(['plugin.js']);
    expect(pkg.openclaw.runtimeExtensions).toEqual(['plugin.js']);
    expect(pkg.files).toContain('postinstall.js');
    expect(pkg.files).not.toContain('scripts/');
    expect(pkg.files).not.toContain('plugin.ts');
  });

  test('declares ownership contracts for every canonical tool', () => {
    const manifest = readJson('openclaw.plugin.json');
    const pkg = readJson('package.json');

    const packageTools = pkg.openclaw.tools.map((tool) => tool.name);

    expect(manifest.contracts.tools).toEqual(TOOL_NAMES);
    expect(manifest).not.toHaveProperty('tools');
    expect(packageTools).toEqual(TOOL_NAMES);
  });
});
