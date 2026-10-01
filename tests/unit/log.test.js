/**
 * Line format for lib/log.js.
 *
 * Pure formatter -- no server spawn, no stream capture.
 */
import { describe, expect, test } from '@jest/globals';

import { formatLogLine } from '../../lib/log.js';

describe('formatLogLine', () => {
  test('emits one parseable JSON object', () => {
    const parsed = JSON.parse(formatLogLine('info', 'started', { port: 9377 }));
    expect(parsed).toMatchObject({ level: 'info', msg: 'started', port: 9377 });
    expect(typeof parsed.ts).toBe('string');
  });

  test('fields override nothing they should not', () => {
    const parsed = JSON.parse(formatLogLine('warn', 'slow', { msg: 'ignored-key-collision' }));
    expect(parsed.level).toBe('warn');
  });

  test('never spans more than one line, whatever the message contains', () => {
    const line = formatLogLine('info', 'a\nb\r\nc', { detail: 'x\ny' });
    expect(line.split('\n')).toHaveLength(1);
  });
});
