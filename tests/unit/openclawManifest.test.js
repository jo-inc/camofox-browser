import { describe, test, expect } from '@jest/globals';
import fs from 'fs';

const RUNTIME_TOOL_RE = /name:\s*["'](camofox_[^"']+)["']/g;

function runtimeToolNames() {
  const plugin = fs.readFileSync(new URL('../../plugin.js', import.meta.url), 'utf8');
  return [...plugin.matchAll(RUNTIME_TOOL_RE)].map(match => match[1]);
}

describe('OpenClaw manifest', () => {
  test('declares ownership contracts for every runtime tool', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const runtimeTools = runtimeToolNames();
    const packageTools = pkg.openclaw.tools.map(tool => tool.name);

    expect(manifest.contracts).toBeDefined();
    expect(manifest.contracts.tools).toEqual(runtimeTools);
    expect(manifest.tools).toEqual(runtimeTools);
    expect(packageTools).toEqual(runtimeTools);
  });
});
