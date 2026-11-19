import { afterEach, describe, expect, test } from '@jest/globals';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { platform, tmpdir } from 'os';
import { prepareExternalCamoufoxExecutable } from '../../lib/camoufox-executable.js';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'camofox-executable-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(join(tmpdir(), 'camofox-browser-external-camoufox'), { recursive: true, force: true });
});

describe('prepareExternalCamoufoxExecutable', () => {
  test('creates camoufox-js compatibility links for an external bundle', () => {
    const bundleDir = makeTempDir();
    const cacheDir = makeTempDir();
    const executable = join(bundleDir, 'camoufox-bin');

    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    writeFileSync(join(bundleDir, 'properties.json'), '[]\n');
    writeFileSync(join(bundleDir, 'version.json'), '{"version":"135.0.1","release":"beta.24"}\n');
    mkdirSync(join(bundleDir, 'fontconfig', 'lin'), { recursive: true });

    const prepared = prepareExternalCamoufoxExecutable(executable, { cacheDir });

    expect(prepared.resourceDir).toBe(bundleDir);
    expect(prepared.executablePath).toContain('camofox-browser-external-camoufox');
    expect(existsSync(prepared.executablePath)).toBe(true);
    expect(existsSync(join(cacheDir, 'version.json'))).toBe(true);
    expect(existsSync(join(cacheDir, 'fontconfig'))).toBe(true);
    expect(existsSync(join(cacheDir, 'properties.json'))).toBe(true);
    const cacheExecutable = platform() === 'darwin'
      ? join(cacheDir, 'Camoufox.app', 'Contents', 'MacOS', 'camoufox')
      : join(cacheDir, platform() === 'win32' ? 'camoufox.exe' : 'camoufox-bin');
    expect(existsSync(cacheExecutable)).toBe(true);
  });

  test('accepts an existing cache version only when it matches the bundle', () => {
    const bundleDir = makeTempDir();
    const cacheDir = makeTempDir();
    const executable = join(bundleDir, 'camoufox-bin');

    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    writeFileSync(join(bundleDir, 'properties.json'), '[]\n');
    writeFileSync(join(bundleDir, 'version.json'), '{"version":"new"}\n');
    mkdirSync(join(bundleDir, 'fontconfig', 'lin'), { recursive: true });
    writeFileSync(join(cacheDir, 'version.json'), '{"version":"new"}\n');

    expect(() => prepareExternalCamoufoxExecutable(executable, { cacheDir })).not.toThrow();
  });

  test('fails closed when an existing cache version does not match the bundle', () => {
    const bundleDir = makeTempDir();
    const cacheDir = makeTempDir();
    const executable = join(bundleDir, 'camoufox-bin');

    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    writeFileSync(join(bundleDir, 'properties.json'), '[]\n');
    writeFileSync(join(bundleDir, 'version.json'), '{"version":"new"}\n');
    mkdirSync(join(bundleDir, 'fontconfig', 'lin'), { recursive: true });
    writeFileSync(join(cacheDir, 'version.json'), '{"version":"existing"}\n');

    expect(() => prepareExternalCamoufoxExecutable(executable, { cacheDir }))
      .toThrow(/cache version does not match/);
  });

  test('accepts an already-created cache symlink only when it targets the expected resource', () => {
    const bundleDir = makeTempDir();
    const cacheDir = makeTempDir();
    const executable = join(bundleDir, 'camoufox-bin');

    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    writeFileSync(join(bundleDir, 'properties.json'), '[]\n');
    writeFileSync(join(bundleDir, 'version.json'), '{"version":"new"}\n');
    mkdirSync(join(bundleDir, 'fontconfig', 'lin'), { recursive: true });

    symlinkSync(join(bundleDir, 'properties.json'), join(cacheDir, 'properties.json'));
    expect(() => prepareExternalCamoufoxExecutable(executable, { cacheDir })).not.toThrow();
  });

  test('fails closed when an existing cache link points somewhere unexpected', () => {
    const bundleDir = makeTempDir();
    const cacheDir = makeTempDir();
    const outsideDir = makeTempDir();
    const executable = join(bundleDir, 'camoufox-bin');
    const outsideProperties = join(outsideDir, 'properties.json');

    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    writeFileSync(join(bundleDir, 'properties.json'), '[]\n');
    writeFileSync(join(bundleDir, 'version.json'), '{"version":"new"}\n');
    mkdirSync(join(bundleDir, 'fontconfig', 'lin'), { recursive: true });
    writeFileSync(outsideProperties, '[]\n');
    symlinkSync(outsideProperties, join(cacheDir, 'properties.json'));

    expect(() => prepareExternalCamoufoxExecutable(executable, { cacheDir }))
      .toThrow(/unexpected target/);
  });

  test('preserves a macOS app bundle executable instead of flattening it', () => {
    if (platform() !== 'darwin') return;
    const root = makeTempDir();
    const cacheDir = makeTempDir();
    const contents = join(root, 'Camoufox.app', 'Contents');
    const executable = join(contents, 'MacOS', 'camoufox');
    mkdirSync(dirname(executable), { recursive: true });
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    writeFileSync(join(root, 'version.json'), '{"version":"test"}\n');
    writeFileSync(join(contents, 'Resources', 'properties.json'), '[]\n');

    const prepared = prepareExternalCamoufoxExecutable(executable, { cacheDir });

    expect(prepared.resourceDir).toBe(join(contents, 'Resources'));
    expect(prepared.executablePath).toBe(executable);
    expect(existsSync(join(cacheDir, 'version.json'))).toBe(true);
    expect(existsSync(join(dirname(executable), 'properties.json'))).toBe(true);
  });

  test('fails clearly when bundle resources are missing', () => {
    const bundleDir = makeTempDir();
    const executable = join(bundleDir, 'camoufox-bin');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);

    expect(() => prepareExternalCamoufoxExecutable(executable, { cacheDir: makeTempDir() }))
      .toThrow(/properties\.json/);
  });
});
