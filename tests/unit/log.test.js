/**
 * Line format for lib/log.js.
 *
 * Pure formatter -- no server spawn, no stream capture.
 */
import { describe, expect, test } from '@jest/globals';

import { formatLogLine, syslogPrefixEnabled } from '../../lib/log.js';

const PREFIXED = { CAMOFOX_LOG_SYSLOG_PREFIX: '1' };

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

describe('syslog priority prefix', () => {
  test('is off unless explicitly enabled', () => {
    expect(syslogPrefixEnabled({})).toBe(false);
    expect(syslogPrefixEnabled({ CAMOFOX_LOG_SYSLOG_PREFIX: '0' })).toBe(false);
    expect(formatLogLine('error', 'boom', {}, {})).not.toMatch(/^</);
  });

  test.each([
    ['error', 3],
    ['warn', 4],
    ['info', 6],
    ['debug', 7],
  ])('maps %s to <%i>', (level, priority) => {
    expect(formatLogLine(level, 'm', {}, PREFIXED)).toMatch(new RegExp(`^<${priority}>`));
  });

  test('an unknown level falls back to info', () => {
    expect(formatLogLine('trace', 'm', {}, PREFIXED)).toMatch(/^<6>/);
  });

  test('the JSON body still parses once the prefix is stripped', () => {
    const line = formatLogLine('error', 'boom', { reqId: 'abc', code: 500 }, PREFIXED);
    expect(JSON.parse(line.replace(/^<\d+>/, ''))).toMatchObject({
      level: 'error', msg: 'boom', reqId: 'abc', code: 500,
    });
  });
});
