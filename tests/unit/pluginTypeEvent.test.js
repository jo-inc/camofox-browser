/**
 * The tab:type plugin event carried the typed text verbatim, and the text
 * typed into a login form is a password. Any plugin subscribing to the
 * documented contract received it. These tests pin the payload to a length.
 *
 * Pure payload builder -- no server spawn.
 */
import { describe, expect, test } from '@jest/globals';

import { typeEventPayload } from '../../lib/plugins.js';

describe('typeEventPayload', () => {
  test('reports a length instead of the typed text', () => {
    const payload = typeEventPayload({
      userId: 'u1',
      tabId: 't1',
      text: 'hunter2-correct-horse',
      ref: 'input[name=password]',
      mode: 'fill',
    });

    expect(payload).toEqual({
      userId: 'u1',
      tabId: 't1',
      textLength: 21,
      ref: 'input[name=password]',
      mode: 'fill',
    });
  });

  test('no property of the payload contains the typed text', () => {
    const secret = 'hunter2-correct-horse';
    const payload = typeEventPayload({ userId: 'u1', tabId: 't1', text: secret });

    expect(JSON.stringify(payload)).not.toContain(secret);
  });

  test('defaults mode to fill', () => {
    expect(typeEventPayload({ userId: 'u', tabId: 't', text: 'x' }).mode).toBe('fill');
  });

  test('a missing or non-string text reports zero rather than throwing', () => {
    expect(typeEventPayload({ userId: 'u', tabId: 't' }).textLength).toBe(0);
    expect(typeEventPayload({ userId: 'u', tabId: 't', text: null }).textLength).toBe(0);
  });
});
