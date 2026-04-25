import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ensureTracesDir,
  userTracesDir,
  resolveTracePath,
  listUserTraces,
  statTrace,
  deleteTrace,
  sweepOldTraces,
  makeTraceFilename,
} from '../../lib/tracing.js';

function makeTempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-traces-test-'));
}

describe('tracing', () => {
  let baseDir;

  beforeEach(() => {
    baseDir = makeTempBase();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('ensureTracesDir creates a stable hashed directory per user', () => {
    const dir1 = ensureTracesDir(baseDir, 'agent1');
    const dir2 = ensureTracesDir(baseDir, 'agent1');
    const dir3 = ensureTracesDir(baseDir, 'agent2');
    expect(fs.statSync(dir1).isDirectory()).toBe(true);
    expect(dir1).toBe(dir2);
    expect(dir1).not.toBe(dir3);
    expect(userTracesDir(baseDir, 'agent1')).toBe(dir1);
  });

  test('makeTraceFilename produces unique zip names', () => {
    const a = makeTraceFilename();
    const b = makeTraceFilename();
    expect(a).toMatch(/^trace-.*\.zip$/);
    expect(a).not.toBe(b);
  });

  test('resolveTracePath blocks path traversal', () => {
    expect(resolveTracePath(baseDir, 'a', '../../etc/passwd')).toBeNull();
    expect(resolveTracePath(baseDir, 'a', '..')).toBeNull();
    expect(resolveTracePath(baseDir, 'a', 'foo/bar.zip')).toBeNull();
    expect(resolveTracePath(baseDir, 'a', '.hidden')).toBeNull();
    expect(resolveTracePath(baseDir, 'a', '')).toBeNull();
    const ok = resolveTracePath(baseDir, 'a', 'trace-ok.zip');
    expect(ok).not.toBeNull();
    expect(ok.endsWith('trace-ok.zip')).toBe(true);
  });

  test('listUserTraces returns zip files sorted newest first', async () => {
    const dir = ensureTracesDir(baseDir, 'u');
    fs.writeFileSync(path.join(dir, 'one.zip'), 'a');
    const past = Date.now() - 60_000;
    fs.utimesSync(path.join(dir, 'one.zip'), past / 1000, past / 1000);
    fs.writeFileSync(path.join(dir, 'two.zip'), 'bb');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'x');
    const list = await listUserTraces(baseDir, 'u');
    expect(list.map(r => r.filename)).toEqual(['two.zip', 'one.zip']);
    expect(list[0].sizeBytes).toBe(2);
  });

  test('listUserTraces returns empty array when no dir exists', async () => {
    expect(await listUserTraces(baseDir, 'nobody')).toEqual([]);
  });

  test('sweepOldTraces removes files older than ttl', () => {
    const dir = ensureTracesDir(baseDir, 'u');
    const old = path.join(dir, 'old.zip');
    const fresh = path.join(dir, 'fresh.zip');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'y');
    const twoHoursAgo = (Date.now() - 2 * 3600 * 1000) / 1000;
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);

    const result = sweepOldTraces({
      baseDir,
      ttlMs: 3600 * 1000,
      maxBytesPerFile: 10 * 1024 * 1024,
    });

    expect(result.removedTtl).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  test('sweepOldTraces removes files exceeding maxBytesPerFile', () => {
    const dir = ensureTracesDir(baseDir, 'u');
    const big = path.join(dir, 'big.zip');
    const small = path.join(dir, 'small.zip');
    fs.writeFileSync(big, Buffer.alloc(1024));
    fs.writeFileSync(small, Buffer.alloc(100));

    const result = sweepOldTraces({
      baseDir,
      ttlMs: 0,
      maxBytesPerFile: 500,
    });

    expect(result.removedOversized).toBe(1);
    expect(fs.existsSync(big)).toBe(false);
    expect(fs.existsSync(small)).toBe(true);
  });

  test('sweepOldTraces is a no-op when baseDir does not exist', () => {
    const ghost = path.join(baseDir, 'does-not-exist');
    const result = sweepOldTraces({ baseDir: ghost, ttlMs: 1, maxBytesPerFile: 1 });
    expect(result.scanned).toBe(0);
    expect(result.removedTtl).toBe(0);
  });

  test('sweepOldTraces ignores non-zip files', () => {
    const dir = ensureTracesDir(baseDir, 'u');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'fresh.zip'), 'y');
    const result = sweepOldTraces({ baseDir, ttlMs: 1, maxBytesPerFile: 10 });
    expect(result.scanned).toBe(1);
    expect(fs.existsSync(path.join(dir, 'note.txt'))).toBe(true);
  });
});
