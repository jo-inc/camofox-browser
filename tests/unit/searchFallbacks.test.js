import fs from 'fs';
import path from 'path';
import { getSearchFallbacks } from '../../lib/search-fallbacks.js';

const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

describe('search fallbacks', () => {
  test('falls back from the Google macro to DuckDuckGo before Bing', () => {
    expect(getSearchFallbacks('@google_search', 'weather today')).toEqual([
      {
        engine: 'duckduckgo',
        url: 'https://duckduckgo.com/?q=weather%20today',
      },
      {
        engine: 'bing',
        url: 'https://www.bing.com/search?q=weather%20today',
      },
    ]);
  });

  test('does not alter explicit URLs or non-Google macros', () => {
    expect(getSearchFallbacks(null, 'weather today')).toEqual([]);
    expect(getSearchFallbacks('@youtube_search', 'weather today')).toEqual([]);
  });

  test('encodes the fallback query', () => {
    expect(getSearchFallbacks('@google_search', 'C++ & Rust')[0].url)
      .toBe('https://duckduckgo.com/?q=C%2B%2B%20%26%20Rust');
  });

  test('waits for organic Google result cards before falling back', () => {
    expect(serverSource).toContain("import { hasGoogleOrganicResults } from './lib/google-serp.js';");
    expect(serverSource).toContain('if (await hasGoogleOrganicResults(tabState.page)) {');
    expect(serverSource).toContain("log('warn', 'google search returned no organic results; using fallback'");
    expect(serverSource).toContain('googleResultsAvailable: false,');
    expect(serverSource).toContain('searchFallbacksExhausted: searchFallbacks.length > 0,');
  });

  test('keeps the Google fallback path for upstream 5xx responses', () => {
    expect(serverSource).toContain("isGoogleSearch && navErr.code === 'destination_unavailable' && await navigateSearchFallback()");
    // Upstream renamed this binding from `response` to `searchResponse` (there
    // are several responses in scope in navigate()). The 5xx fallback itself is
    // unchanged: it clears the cached snapshot and throws a retryable 502 so the
    // search-fallback chain takes over. Match the behaviour, not the old name.
    expect(serverSource).toMatch(
      /if \(searchResponse && searchResponse\.status\(\) >= 500\) \{\s*tabState\.lastSnapshot = null;\s*throw Object\.assign\(/,
    );
  });

  test('navigation reports the engine used after Google fallback', () => {
    expect(serverSource).toContain("searchFallback = { searchEngine: candidate.engine, fallbackFrom: 'google' }");
    expect(serverSource).toContain('searchFallbackAttempted: searchFallbacks.length > 0');
  });
});
