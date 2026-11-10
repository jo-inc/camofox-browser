import { describe, test, expect } from '@jest/globals';
import { resolveHostOs } from '../../lib/fingerprint-os.js';

// #15106: CAMOFOX_OS lets a deployment override the browser fingerprint OS.
// config.test.js proves the env var parses and is forwarded to subprocesses;
// these cover the launch-path precedence getHostOS() relies on — that a valid
// override actually WINS over the detected host platform, and that the host
// platform is mapped correctly when no override is set.
describe('resolveHostOs (CAMOFOX_OS fingerprint override)', () => {
  test('a set override wins over the host platform', () => {
    // The whole point of the feature: a Linux container can present as Windows.
    expect(resolveHostOs('windows', 'linux')).toBe('windows');
    expect(resolveHostOs('macos', 'linux')).toBe('macos');
    expect(resolveHostOs('linux', 'darwin')).toBe('linux');
  });

  test('falls back to the host platform when no override is set', () => {
    for (const empty of [null, undefined, '']) {
      expect(resolveHostOs(empty, 'darwin')).toBe('macos');
      expect(resolveHostOs(empty, 'win32')).toBe('windows');
      expect(resolveHostOs(empty, 'linux')).toBe('linux');
      // Any other platform (freebsd, etc.) maps to linux.
      expect(resolveHostOs(empty, 'freebsd')).toBe('linux');
    }
  });
});
