import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { hasGoogleOrganicResults, pageHasGoogleOrganicResult } from '../../lib/google-serp.js';

describe('pageHasGoogleOrganicResult', () => {
  afterEach(() => {
    delete globalThis.document;
  });

  function runDetector(linkHref, baseURI = 'https://www.google.com/search?q=test') {
    const heading = { closest: () => ({ href: linkHref }) };
    globalThis.document = {
      querySelector: () => ({ querySelectorAll: () => [heading] }),
      baseURI,
    };
    return pageHasGoogleOrganicResult();
  }

  test('accepts direct external links', () => {
    expect(runDetector('https://example.com/article')).toBe(true);
  });

  test('accepts google-hosted goto and url wrappers', () => {
    expect(runDetector('/goto?url=https://example.com/article')).toBe(true);
    expect(runDetector('/url?q=https://example.com/article')).toBe(true);
  });

  test('rejects ad links and other google paths', () => {
    expect(runDetector('/aclk?sa=L')).toBe(false);
    expect(runDetector('/search?q=test')).toBe(false);
  });

  test('rejects non-http links', () => {
    expect(runDetector('javascript:void(0)')).toBe(false);
  });

  test('accepts wrappers on the SERP host of a regional Google domain', () => {
    expect(runDetector('/goto?url=https://example.com/article', 'https://www.google.ca/search?q=test')).toBe(true);
    expect(runDetector('https://www.google.ca/goto?url=https://example.com/article', 'https://www.google.ca/search?q=test')).toBe(true);
  });

  test('rejects wrapper-shaped links on other google hosts', () => {
    expect(runDetector('https://accounts.google.com/url?q=https://example.com/article')).toBe(false);
    expect(runDetector('https://www.google.com/goto?url=https://example.com/article', 'https://www.google.ca/search?q=test')).toBe(false);
  });

  test('returns false without a result container or a linked heading', () => {
    globalThis.document = { querySelector: () => null, baseURI: 'https://www.google.com/search?q=test' };
    expect(pageHasGoogleOrganicResult()).toBe(false);

    const heading = { closest: () => null };
    globalThis.document = {
      querySelector: () => ({ querySelectorAll: () => [heading] }),
      baseURI: 'https://www.google.com/search?q=test',
    };
    expect(pageHasGoogleOrganicResult()).toBe(false);
  });
});

describe('hasGoogleOrganicResults', () => {
  test('returns immediately when an organic card is present', async () => {
    const page = {
      isClosed: jest.fn(() => false),
      evaluate: jest.fn().mockResolvedValue(true),
      waitForFunction: jest.fn(),
    };

    await expect(hasGoogleOrganicResults(page)).resolves.toBe(true);
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  test('waits for cards before classifying a Google shell as empty', async () => {
    const page = {
      isClosed: jest.fn(() => false),
      evaluate: jest.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false),
      waitForFunction: jest.fn().mockRejectedValue(new Error('timeout')),
    };

    await expect(hasGoogleOrganicResults(page)).resolves.toBe(false);
    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), { timeout: 5000 });
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  test('accepts organic cards that render during the wait', async () => {
    const page = {
      isClosed: jest.fn(() => false),
      evaluate: jest.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
    };

    await expect(hasGoogleOrganicResults(page)).resolves.toBe(true);
  });

  test('returns false for a closed page', async () => {
    const page = { isClosed: jest.fn(() => true) };

    await expect(hasGoogleOrganicResults(page)).resolves.toBe(false);
  });
});
