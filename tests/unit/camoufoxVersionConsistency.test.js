import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => readFileSync(path.join(rootDir, file), 'utf8');

function capture(source, pattern, file) {
  const match = source.match(pattern);
  assert.ok(match, `Could not find Camoufox version in ${file}`);
  return match[1];
}

describe('Camoufox release defaults', () => {
  test('match the version bundled by the npm installer', () => {
    const bundledRelease = capture(
      read('lib/camoufox-download.js'),
      /BUNDLED_CAMOUFOX_RELEASE\s*=\s*'([^']+)'/,
      'lib/camoufox-download.js',
    );
    const [version, release] = bundledRelease.match(/^(.+)-(beta\.\d+)$/).slice(1);
    const defaults = [
      ['Dockerfile', /ARG CAMOUFOX_VERSION=([^\s]+)/, /ARG CAMOUFOX_RELEASE=([^\s]+)/],
      ['Dockerfile.ci', /ARG CAMOUFOX_VERSION=([^\s]+)/, /ARG CAMOUFOX_RELEASE=([^\s]+)/],
      ['Makefile', /^VERSION\s*\?=\s*([^\s]+)/m, /^RELEASE\s*\?=\s*([^\s]+)/m],
      [
        'build.ps1',
        /\$CamoufoxVersion\s*=\s*'([^']+)'/,
        /\$CamoufoxRelease\s*=\s*'([^']+)'/,
      ],
    ];

    for (const [file, versionPattern, releasePattern] of defaults) {
      const source = read(file);
      assert.equal(capture(source, versionPattern, file), version, `${file} version`);
      assert.equal(capture(source, releasePattern, file), release, `${file} release`);
    }
  });
});
