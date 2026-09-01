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

describe('consent dismissal safety contract', () => {
  const waitForPageReady = sourceBetween(
    'async function waitForPageReady',
    'async function dismissConsentDialogs'
  );
  const dismissConsentDialogs = sourceBetween(
    'async function dismissConsentDialogs',
    '// --- Google SERP detection ---'
  );

  test('does not dismiss dialogs unless explicitly requested', () => {
    expect(waitForPageReady).toContain('dismissConsent = false');
    expect(waitForPageReady).toContain('if (dismissConsent) {');
  });

  test('does not use generic dialog or modal selectors', () => {
    expect(dismissConsentDialogs).not.toMatch(/dialog button|\[class\*="modal"\]|\[class\*="overlay"\]|aria-label="Close"/);
    expect(dismissConsentDialogs).toContain('#onetrust-banner-sdk');
  });

  test('exposes consent dismissal as an opt-in wait request', () => {
    const waitRoute = sourceBetween(
      "app.post('/tabs/:tabId/wait'",
      "app.post('/tabs/:tabId/click'"
    );
    expect(waitRoute).toContain('dismissConsent = false');
    expect(waitRoute).toContain('waitForPageReady(tabState.page, { timeout, waitForNetwork, dismissConsent })');
  });
});
