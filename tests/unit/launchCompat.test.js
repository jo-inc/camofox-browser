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

    expect(defaultVirtualDisplay).toContain("DEFAULT_VIRTUAL_DISPLAY_RESOLUTION = '1920x1080x24'");
    expect(defaultVirtualDisplay).toContain('class DefaultVirtualDisplay extends VirtualDisplay');
    expect(defaultVirtualDisplay).toContain('patched[idx + 1] = DEFAULT_VIRTUAL_DISPLAY_RESOLUTION');
    expect(pluginContext).toContain('registerVirtualDisplayProvider: (pluginName, factory) => virtualDisplayRegistry.register(pluginName, factory)');
  });

  test('does not configure a fixed default browser context viewport', () => {
    const googleProbeOptions = sourceBetween(
      'context = await candidateBrowser.newContext({',
      'const page = await context.newPage();'
    );
    const sessionContextOptions = sourceBetween(
      'const contextOptions = {',
      'let sessionProxy = null;'
    );

    expect(googleProbeOptions).toContain('viewport: null');
    expect(sessionContextOptions).toContain('viewport: null');
    expect(`${googleProbeOptions}\n${sessionContextOptions}`).not.toMatch(/viewport\s*:\s*\{\s*width\s*:/);
  });

  test('does not fake a direct-session location and applies an explicit identity only when configured', () => {
    const probeOptions = sourceBetween(
      'async function probeGoogleSearch(candidateBrowser) {',
      'const page = await context.newPage();'
    );
    const sessionContextOptions = sourceBetween(
      'const contextOptions = {',
      'let sessionProxy = null;'
    );
    const launchBrowser = sourceBetween(
      'async function launchBrowserInstance()',
      'async function ensureBrowser()'
    );

    expect(`${probeOptions}\n${sessionContextOptions}`).toContain('contextIdentityOptions({');
    expect(`${probeOptions}\n${sessionContextOptions}`).not.toContain('geolocation:');
    expect(`${probeOptions}\n${sessionContextOptions}`).not.toContain('37.7749');
    expect(launchBrowser).toContain('locale: launchLocale({ hasProxy: !!proxyPool, directIdentity: CONFIG.directIdentity })');
  });

  test('uses a real desktop window only when interactive desktop mode is explicit', () => {
    const launch = sourceBetween(
      'async function launchBrowserInstance()',
      'async function ensureBrowser()'
    );

    expect(launch).toContain("const useDesktopWindow = CONFIG.interactiveMode === 'desktop'");
    expect(launch).toContain("if (os.platform() === 'linux' && !useDesktopWindow)");
    expect(launch).toContain('headless: useVirtualDisplay ? false : !useDesktopWindow');
    expect(launch).toContain('screen: localVirtualDisplay ? virtualDisplayScreen(localVirtualDisplay) : undefined');
  });

  test('falls back when optional GeoIP setup is unavailable', () => {
    const geoipFallback = sourceBetween(
      'function isCamoufoxGeoipError',
      'async function launchBrowserInstance()'
    );
    const launchBrowser = sourceBetween(
      'async function launchBrowserInstance()',
      'async function ensureBrowser()'
    );

    expect(geoipFallback).toMatch(/GeoLite\|MaxMind\|geolocation/);
    expect(geoipFallback).toContain('public proxy IP address');
    expect(serverSource).toContain('GEOIP_SETUP_TIMEOUT_MS = 10000');
    expect(geoipFallback).toContain("withTimeout(launchOptions(baseOptions), GEOIP_SETUP_TIMEOUT_MS, 'GeoIP setup')");
    expect(geoipFallback).toContain('geoip: false');
    expect(launchBrowser).toContain('buildLaunchOptionsWithGeoipFallback');
  });

  test('health probe context also uses a null viewport', () => {
    const healthProbeOptions = sourceBetween(
      'testContext = await browser.newContext(',
      'const page = await testContext.newPage();'
    );

    expect(healthProbeOptions).toContain('viewport: null');
  });

  test('uses the configured navigation timeout without racing its request deadline', () => {
    const navigateRoute = sourceBetween(
      "app.post('/tabs/:tabId/navigate'",
      '// Snapshot'
    );

    expect(serverSource).toContain('function navigationRequestTimeoutMs()');
    expect(serverSource).toContain('NAVIGATE_TIMEOUT_MS + 5000');
    expect(navigateRoute).toContain('timeout: NAVIGATE_TIMEOUT_MS');
    expect(navigateRoute).toContain("})(), navigationRequestTimeoutMs(), 'navigate'))");
  });
});
