import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { importBootstrapCookies } from '../../lib/cookies.js';

describe('importBootstrapCookies', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-bootstrap-cookies-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns zero without calling addCookies when cookies.txt is missing', async () => {
    const context = { addCookies: jest.fn() };
    const logger = { warn: jest.fn() };

    const result = await importBootstrapCookies({ cookiesDir: tmpDir, context, logger });

    expect(result.imported).toBe(0);
    expect(result.source).toBe(null);
    expect(context.addCookies).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('imports all cookies from the default cookies.txt file', async () => {
    const cookieText = [
      '# Netscape HTTP Cookie File',
      '.example.com\tTRUE\t/\tTRUE\t1700000000\tlogged_in\tyes',
      'app.example.org\tFALSE\t/\tTRUE\t1700000000\t__cflb\tabc123',
    ].join('\n');
    await fs.writeFile(path.join(tmpDir, 'cookies.txt'), cookieText);

    const context = { addCookies: jest.fn(async () => {}) };

    const result = await importBootstrapCookies({ cookiesDir: tmpDir, context, logger: { warn: jest.fn() } });

    expect(result.imported).toBe(2);
    expect(result.source.endsWith(path.join(tmpDir, 'cookies.txt'))).toBe(true);
    expect(context.addCookies).toHaveBeenCalledTimes(1);
    expect(context.addCookies.mock.calls[0][0]).toEqual([
      expect.objectContaining({ domain: '.example.com', name: 'logged_in', value: 'yes' }),
      expect.objectContaining({ domain: 'app.example.org', name: '__cflb', value: 'abc123' }),
    ]);
  });

  test('logs and returns zero when addCookies throws', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'cookies.txt'),
      '.example.com\tTRUE\t/\tTRUE\t1700000000\tlogged_in\tyes\n'
    );

    const context = { addCookies: jest.fn(async () => { throw new Error('boom'); }) };
    const logger = { warn: jest.fn() };

    const result = await importBootstrapCookies({ cookiesDir: tmpDir, context, logger });

    expect(result.imported).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});
