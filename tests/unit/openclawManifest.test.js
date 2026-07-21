import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import { TOOL_NAMES } from '../../lib/mcp-tool-contracts.mjs';

// Canonical tool contracts (lib/mcp-tool-contracts.mjs) are the single source
// of truth shared by the OpenClaw plugin (plugin.ts) and the MCP server
// (mcp/server.mjs). The OpenClaw manifests must mirror that list exactly — this
// guard fails if a tool is added/removed/renamed in one place but not the others.

function readJson(rel) {
  return JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
}

describe('OpenClaw manifest', () => {
  test('declares ownership contracts for every canonical tool', () => {
    const manifest = readJson('openclaw.plugin.json');
    const pkg = readJson('package.json');

    const manifestContracts = manifest.contracts.tools;
    const manifestTools = manifest.tools;
    const packageTools = pkg.openclaw.tools.map((tool) => tool.name);

    expect(manifestContracts).toEqual(TOOL_NAMES);
    expect(manifestTools).toEqual(TOOL_NAMES);
    expect(packageTools).toEqual(TOOL_NAMES);
  });
});
