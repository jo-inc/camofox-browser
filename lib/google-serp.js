const GOOGLE_ORGANIC_RESULT_WAIT_MS = 5000;

export function pageHasGoogleOrganicResult() {
  const resultContainer = document.querySelector('#rso') || document.querySelector('#search');
  if (!resultContainer) return false;

  const pageHost = new URL(document.baseURI).hostname;

  return [...resultContainer.querySelectorAll('h3')].some((heading) => {
    const link = heading.closest('a[href]');
    if (!link?.href) return false;
    try {
      const url = new URL(link.href, document.baseURI);
      if (!/^https?:$/.test(url.protocol)) return false;
      if (!/(^|\.)google\./i.test(url.hostname)) return true;
      // Ads use /aclk and stay excluded; wrappers only count on the SERP's own host.
      return url.hostname === pageHost && /^\/(goto|url)$/.test(url.pathname);
    } catch {
      return false;
    }
  });
}

export async function hasGoogleOrganicResults(page) {
  if (!page || page.isClosed()) return false;

  const hasResults = () => page.evaluate(pageHasGoogleOrganicResult).catch(() => false);
  if (await hasResults()) return true;

  try {
    await page.waitForFunction(pageHasGoogleOrganicResult, {
      timeout: GOOGLE_ORGANIC_RESULT_WAIT_MS,
    });
  } catch {
    // The caller classifies a still-empty result page and uses the fallback.
  }

  return hasResults();
}

// The two helpers below run in the page: extractGoogleSerp passes their source to page.evaluate, so
// they must stay self-contained (no imports, no module-level references).

// The result card for an organic h3. Selectors are tried one at a time, card first: closest() with a
// selector list returns the NEAREST ancestor matching any entry, which on current Google markup is the
// header-only [data-snhf] div (title and cite), not the card that also holds the snippet.
export function serpResultBlock(h3, mainLink, resultContainer) {
  for (const sel of ['.MjjYud', '.g', '[data-snhf], [data-content-feature]']) {
    const block = h3.closest(sel);
    if (block) return block;
  }
  return mainLink.parentElement?.parentElement || mainLink.parentElement || resultContainer;
}

// The snippet text of a result block, or '' when it has none.
export function serpSnippet(block, h3) {
  for (const sel of ['[data-sncf]', '[data-content-feature="1"]', '.VwiC3b', 'div[style*="-webkit-line-clamp"]', 'span.aCOpRe']) {
    const el = block.querySelector(sel);
    if (el && !h3.contains(el)) {
      const text = el.textContent.trim().slice(0, 300);
      if (text) return text;
      break;
    }
  }
  const title = h3.textContent.trim();
  const allText = block.textContent.trim().replace(/\s+/g, ' ');
  const titleOffset = allText.indexOf(title);
  const afterTitle = titleOffset >= 0 ? allText.slice(titleOffset + title.length) : allText;
  return afterTitle.length > 20 ? afterTitle.trim().slice(0, 300) : '';
}
