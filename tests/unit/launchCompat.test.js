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

  test('sizes the default virtual display used with null context viewports', () => {
    const defaultVirtualDisplay = sourceBetween(
      'const DEFAULT_VIRTUAL_DISPLAY_RESOLUTION',
      'let virtualDisplay = null;'
    );
    const pluginContext = sourceBetween(
      'const pluginCtx = {',
      'const loadedPlugins = await loadPlugins'
    );

    expect(defaultVirtualDisplay).toContain("DEFAULT_VIRTUAL_DISPLAY_RESOLUTION = '1280x720x24'");
    expect(defaultVirtualDisplay).toContain('class DefaultVirtualDisplay extends VirtualDisplay');
    expect(defaultVirtualDisplay).toContain('patched[idx + 1] = DEFAULT_VIRTUAL_DISPLAY_RESOLUTION');
    expect(pluginContext).toContain('createVirtualDisplay: () => new DefaultVirtualDisplay()');
  });

  test('does not configure a fixed default browser context viewport', () => {
    const googleProbeOptions = sourceBetween(
      'async function probeGoogleSearch(candidateBrowser) {',
      'const page = await context.newPage();'
    );
    const sessionContextOptions = sourceBetween(
      'const b = await ensureBrowser();',
      'let sessionProxy = null;'
    );

    expect(googleProbeOptions).toContain('viewport: null');
    expect(sessionContextOptions).toContain('viewport: null');
    expect(`${googleProbeOptions}\n${sessionContextOptions}`).not.toMatch(/viewport\s*:\s*\{\s*width\s*:/);
  });

  test('does not grant geolocation or use fixed coordinates in direct sessions', () => {
    const googleProbeOptions = sourceBetween(
      'async function probeGoogleSearch(candidateBrowser) {',
      'const page = await context.newPage();'
    );
    const sessionContextOptions = sourceBetween(
      'const b = await ensureBrowser();',
      'let sessionProxy = null;'
    );

    expect(googleProbeOptions).toContain('...contextIdentityOptions({');
    expect(sessionContextOptions).toContain('...contextIdentityOptions({');
    expect(sessionContextOptions).not.toContain('geolocation:');
    expect(sessionContextOptions).not.toContain('37.7749');
  });

  test('uses configured locales for direct Camoufox launch identity', () => {
    const launchOptionsBlock = sourceBetween(
      'const options = await launchOptions({',
      'options.proxy = normalizePlaywrightProxy(options.proxy);'
    );

    expect(launchOptionsBlock).toContain('locale: launchLocale({ hasProxy: !!proxyPool, locales: CONFIG.locales })');
  });
});
