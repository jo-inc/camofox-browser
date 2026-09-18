import { describe, expect, test } from '@jest/globals';
import { shouldRetryCreateTab } from '../helpers/client.js';

describe('create-tab retries', () => {
  test('retries a server-declared recoverable session restart', () => {
    expect(shouldRetryCreateTab({
      status: 503,
      message: 'Browser session expired. Retry to get a fresh session.',
      data: { code: 'session_expired', retryable: true },
    })).toBe(true);
  });

  test('does not retry an ordinary client error', () => {
    expect(shouldRetryCreateTab({
      status: 400,
      message: 'url or macro required',
      data: { retryable: false },
    })).toBe(false);
  });
});
