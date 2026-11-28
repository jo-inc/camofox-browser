/**
 * Detects a click that took effect even though Playwright reported an error.
 *
 * A click that starts a navigation slower than the click's own timeout is
 * reported as a timeout. Retrying it with a fallback clicks a second time:
 * a second form submit, or a click on whatever is at that spot on the next
 * page. If the page URL changed since the click started, the click worked.
 */
export function createNavigationCheck(page) {
  const urlBefore = page.url();
  return async function navigatedSinceClick(timeoutMs) {
    if (page.url() !== urlBefore) return true;
    if (!(timeoutMs > 0)) return false;
    return page
      .waitForURL((url) => url.toString() !== urlBefore, { timeout: timeoutMs, waitUntil: 'commit' })
      .then(() => true, () => false);
  };
}
