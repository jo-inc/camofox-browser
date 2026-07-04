const { readFileSync } = process.getBuiltinModule('fs');
const { join } = process.getBuiltinModule('path');

const serverSource = readFileSync(join(process.cwd(), 'server.js'), 'utf-8');

function sourceBetween(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return serverSource.slice(start, end);
}

describe('launch compatibility source contract', () => {

  test('awaits virtual display display string before launch', () => {
    expect(serverSource).toMatch(/vdDisplay\s*=\s*await\s+localVirtualDisplay\.get\(\)/);
    expect(serverSource).not.toMatch(/vdDisplay\s*=\s*localVirtualDisplay\.get\(\)/);
  });

  test('does not configure a fixed default browser context viewport', () => {
    const googleProbeOptions = sourceBetween(
      'context = await candidateBrowser.newContext({',
      'const page = await context.newPage();'
    );
    const sessionContextOptions = sourceBetween(
      'const contextOptions = {',
      '// When geoip is active'
    );

    expect(googleProbeOptions).toContain('viewport: null');
    expect(sessionContextOptions).toContain('viewport: null');
    expect(`${googleProbeOptions}\n${sessionContextOptions}`).not.toMatch(/viewport\s*:\s*\{\s*width\s*:/);
  });
});
