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

describe('removeXvfbDisplayFiles', () => {
  it('removes both the socket and lock file for the given display', () => {
    const socketDir = makeTmpDir();
    const lockDir = makeTmpDir();
    const socket = path.join(socketDir, 'X99');
    const lock = path.join(lockDir, '.X99-lock');
    fs.writeFileSync(socket, '');
    fs.writeFileSync(lock, '12345');

    removeXvfbDisplayFiles(99, { socketDir, lockDir });

    expect(fs.existsSync(socket)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    fs.rmSync(socketDir, { recursive: true, force: true });
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it('removes whichever of the two exists, leaving unrelated displays alone', () => {
    const socketDir = makeTmpDir();
    const lockDir = makeTmpDir();
    const targetSocket = path.join(socketDir, 'X42');
    const otherSocket = path.join(socketDir, 'X0');
    fs.writeFileSync(targetSocket, '');
    fs.writeFileSync(otherSocket, '');
    // No .X42-lock written -- only the socket exists for this display.

    removeXvfbDisplayFiles(42, { socketDir, lockDir });

    expect(fs.existsSync(targetSocket)).toBe(false);
    expect(fs.existsSync(otherSocket)).toBe(true);
    fs.rmSync(socketDir, { recursive: true, force: true });
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it('does not throw when neither file exists', () => {
    const socketDir = makeTmpDir();
    const lockDir = makeTmpDir();
    expect(() => removeXvfbDisplayFiles(7777, { socketDir, lockDir })).not.toThrow();
    fs.rmSync(socketDir, { recursive: true, force: true });
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it.each([null, undefined])('is a no-op for displayNum=%p', (displayNum) => {
    const socketDir = makeTmpDir();
    const lockDir = makeTmpDir();
    expect(() => removeXvfbDisplayFiles(displayNum, { socketDir, lockDir })).not.toThrow();
    fs.rmSync(socketDir, { recursive: true, force: true });
    fs.rmSync(lockDir, { recursive: true, force: true });
  });
});
