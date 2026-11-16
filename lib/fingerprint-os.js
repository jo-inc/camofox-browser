'use strict';

// Resolve the OS label used for the Camoufox browser fingerprint.
//
// Camoufox fingerprints follow the host OS by default. Linux desktop Firefox is
// rare among real visitors and some bot managers reject it outright, so a
// deployment can override the fingerprint OS via CAMOFOX_OS (surfaced on config
// as `fingerprintOs`). This helper is the single precedence rule shared by the
// launch path: an explicit override always wins; otherwise map the Node
// platform string to Camoufox's OS label.
//
// Pure and dependency-free so the launch-time behavior (override actually wins)
// can be unit-tested without booting the server or launching a browser.

/**
 * @param {string|null|undefined} fingerprintOs - Validated override
 *   ('windows' | 'macos' | 'linux') or null/undefined for host default.
 * @param {string} platform - A Node `os.platform()` value (e.g. 'darwin').
 * @returns {'windows'|'macos'|'linux'} The OS label handed to Camoufox.
 */
export function resolveHostOs(fingerprintOs, platform) {
  if (fingerprintOs) return fingerprintOs;
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}
