import { afterEach, describe, expect, test } from '@jest/globals';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { platform, tmpdir } from 'os';
import { prepareExternalCamoufoxExecutable } from '../../lib/camoufox-executable.js';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'camofox-executable-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeBundle({ version = true, fontconfig = true } = {}) {
  const bundleDir = makeTempDir();
  const executable = join(bundleDir, 'camoufox-bin');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  writeFileSync(join(bundleDir, 'properties.json'), '[]\n');
  if (version) writeFileSync(join(bundleDir, 'version.json'), '{"version":"158.0.1","release":"beta.41"}\n');
  if (fontconfig) mkdirSync(join(bundleDir, 'fontconfig', 'lin'), { recursive: true });
  return { bundleDir, executable };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('prepareExternalCamoufoxExecutable', () => {
  test('launches an external bundle in place', () => {
    const { bundleDir, executable } = makeBundle();

    const prepared = prepareExternalCamoufoxExecutable(executable);

    // The official camoufox package reads properties.json, application.ini
    // and addons/ beside the path it launches, so no shim or cache is built.
    expect(prepared).toEqual({ executablePath: executable, resourceDir: bundleDir });
  });

  test('follows a symlinked executable into its bundle', () => {
    if (platform() === 'win32') return;
    const { bundleDir, executable } = makeBundle();
    const link = join(makeTempDir(), 'camoufox');
    symlinkSync(executable, link);

    const prepared = prepareExternalCamoufoxExecutable(link);

    expect(prepared.executablePath).toBe(realpathSync(executable));
    expect(prepared.resourceDir).toBe(realpathSync(bundleDir));
  });

  test('requires version.json and fontconfig/ beside the executable', () => {
    expect(() => prepareExternalCamoufoxExecutable(makeBundle({ version: false }).executable))
      .toThrow(/version\.json, and fontconfig/);
    expect(() => prepareExternalCamoufoxExecutable(makeBundle({ fontconfig: false }).executable))
      .toThrow(/version\.json, and fontconfig/);
  });

  test('keeps a macOS app bundle executable in place', () => {
    if (platform() !== 'darwin') return;
    const root = makeTempDir();
    const contents = join(root, 'Camoufox.app', 'Contents');
    const executable = join(contents, 'MacOS', 'camoufox');
    mkdirSync(dirname(executable), { recursive: true });
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    writeFileSync(join(contents, 'Resources', 'properties.json'), '[]\n');

    const prepared = prepareExternalCamoufoxExecutable(executable);

    expect(prepared.resourceDir).toBe(join(contents, 'Resources'));
    expect(prepared.executablePath).toBe(executable);
  });

  test('fails clearly when bundle resources are missing', () => {
    const bundleDir = makeTempDir();
    const executable = join(bundleDir, 'camoufox-bin');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);

    expect(() => prepareExternalCamoufoxExecutable(executable))
      .toThrow(/properties\.json/);
  });
});
