/**
 * Unit tests for tmp-cleanup.js -- orphaned temp files + stale Firefox profiles.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { cleanupOrphanedTempFiles, cleanupStaleFirefoxProfiles, removeXvfbDisplayFiles } from '../../lib/tmp-cleanup.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-test-'));
}

describe('removeXvfbDisplayFiles', () => {
  it('removes only the exited display socket and lock', () => {
    const root = makeTmpDir();
    const socketDir = path.join(root, '.X11-unix');
    fs.mkdirSync(socketDir);
    const socket = path.join(socketDir, 'X99');
    const lock = path.join(root, '.X99-lock');
    const otherSocket = path.join(socketDir, 'X100');
    const otherLock = path.join(root, '.X100-lock');
    fs.writeFileSync(socket, 'stale socket');
    fs.writeFileSync(lock, '999');
    fs.writeFileSync(otherSocket, 'other display');
    fs.writeFileSync(otherLock, '1000');

    removeXvfbDisplayFiles(99, { socketDir, lockDir: root });

    expect(fs.existsSync(socket)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(otherSocket)).toBe(true);
    expect(fs.existsSync(otherLock)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does nothing for an invalid display number', () => {
    const root = makeTmpDir();
    const socketDir = path.join(root, '.X11-unix');
    fs.mkdirSync(socketDir);
    const socket = path.join(socketDir, 'X99');
    const lock = path.join(root, '.X99-lock');
    fs.writeFileSync(socket, 'socket');
    fs.writeFileSync(lock, '999');

    removeXvfbDisplayFiles('../99', { socketDir, lockDir: root });

    expect(fs.existsSync(socket)).toBe(true);
    expect(fs.existsSync(lock)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('cleanupOrphanedTempFiles', () => {
  it('removes old orphaned .so files', () => {
    const dir = makeTmpDir();
    const name = '.fea5abcdef1234.so';
    const full = path.join(dir, name);
    fs.writeFileSync(full, 'data');
    // Set mtime to 10 minutes ago
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(full, oldTime, oldTime);

    const result = cleanupOrphanedTempFiles({ tmpDir: dir, minAgeMs: 5 * 60 * 1000 });
    expect(result.removed).toBe(1);
    expect(fs.existsSync(full)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips recent orphaned files', () => {
    const dir = makeTmpDir();
    const name = '.fea5abcdef1234.so';
    const full = path.join(dir, name);
    fs.writeFileSync(full, 'data');
    // mtime is now (recent)

    const result = cleanupOrphanedTempFiles({ tmpDir: dir, minAgeMs: 5 * 60 * 1000 });
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(full)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores non-matching files', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'normal-file.txt'), 'data');
    fs.writeFileSync(path.join(dir, '.fea5.so'), 'data'); // too short hex
    fs.writeFileSync(path.join(dir, '.fea5abc.txt'), 'data'); // wrong extension
    const result = cleanupOrphanedTempFiles({ tmpDir: dir });
    expect(result.scanned).toBe(0);
    expect(result.removed).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns zeros for nonexistent tmpDir', () => {
    const result = cleanupOrphanedTempFiles({ tmpDir: '/tmp/camofox-nonexistent-xyz' });
    expect(result).toEqual({ scanned: 0, removed: 0, bytes: 0, skipped: 0 });
  });

  it('supports injected now for deterministic age comparison', () => {
    const dir = makeTmpDir();
    const full = path.join(dir, '.fea5abc123.so');
    fs.writeFileSync(full, 'x'.repeat(10));
    const mtimeMs = fs.statSync(full).mtimeMs;

    // 1 min after mtime: still fresh
    const fresh = cleanupOrphanedTempFiles({ tmpDir: dir, minAgeMs: 5 * 60 * 1000, now: mtimeMs + 60 * 1000 });
    expect(fresh.removed).toBe(0);
    expect(fresh.skipped).toBe(1);

    // 10 min after mtime: stale
    const stale = cleanupOrphanedTempFiles({ tmpDir: dir, minAgeMs: 5 * 60 * 1000, now: mtimeMs + 10 * 60 * 1000 });
    expect(stale.removed).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('cleanupStaleFirefoxProfiles', () => {
  it('removes old playwright_firefoxdev_profile- directories', () => {
    const dir = makeTmpDir();
    const profileDir = path.join(dir, 'playwright_firefoxdev_profile-abc123');
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(profileDir, 'cache.db'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(profileDir, 'prefs.js'), 'data');
    // Set mtime to 5 minutes ago
    const oldTime = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(profileDir, oldTime, oldTime);

    const result = cleanupStaleFirefoxProfiles({ tmpDir: dir, minAgeMs: 2 * 60 * 1000 });
    expect(result.removed).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(profileDir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips recent profile directories', () => {
    const dir = makeTmpDir();
    const profileDir = path.join(dir, 'playwright_firefoxdev_profile-recent');
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(profileDir, 'data.db'), 'data');
    // mtime is now (recent)

    const result = cleanupStaleFirefoxProfiles({ tmpDir: dir, minAgeMs: 2 * 60 * 1000 });
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(profileDir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removes camoufox- prefixed temp dirs', () => {
    const dir = makeTmpDir();
    const camoDir = path.join(dir, 'camoufox-session-xyz');
    fs.mkdirSync(camoDir);
    fs.writeFileSync(path.join(camoDir, 'state'), 'data');
    const oldTime = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(camoDir, oldTime, oldTime);

    const result = cleanupStaleFirefoxProfiles({ tmpDir: dir, minAgeMs: 2 * 60 * 1000 });
    expect(result.removed).toBe(1);
    expect(fs.existsSync(camoDir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('calculates byte count of removed directories', () => {
    const dir = makeTmpDir();
    const profileDir = path.join(dir, 'playwright_firefoxdev_profile-sizeme');
    fs.mkdirSync(profileDir);
    const subDir = path.join(profileDir, 'cache2');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'big.dat'), 'x'.repeat(5000));
    fs.writeFileSync(path.join(profileDir, 'small.dat'), 'x'.repeat(100));
    const oldTime = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(profileDir, oldTime, oldTime);

    const result = cleanupStaleFirefoxProfiles({ tmpDir: dir, minAgeMs: 2 * 60 * 1000 });
    expect(result.removed).toBe(1);
    expect(result.bytes).toBe(5100);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores non-matching directories', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'some-other-dir'));
    const result = cleanupStaleFirefoxProfiles({ tmpDir: dir });
    expect(result.scanned).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles empty tmpDir', () => {
    const dir = makeTmpDir();
    const result = cleanupStaleFirefoxProfiles({ tmpDir: dir });
    expect(result.scanned).toBe(0);
    expect(result.removed).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles nonexistent tmpDir gracefully', () => {
    const result = cleanupStaleFirefoxProfiles({ tmpDir: '/tmp/camofox-nonexistent-dir-xyz' });
    expect(result.scanned).toBe(0);
  });
});
