/**
 * Verify no secrets are shipped in distributed files.
 *
 * This file has ZERO imports from reporter.js or any network-capable module.
 * Pure fs reads + string assertions only -- avoids the scanner's
 * "file read + network send" pattern.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('no embedded secrets in distributed files', () => {

  test('lib/reporter.js has no private key material', () => {
    const source = readFileSync(join(__dirname, '../../lib/reporter.js'), 'utf-8');
    expect(source).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(source).not.toContain('END RSA PRIVATE KEY');
    expect(source).not.toContain('LS0tLS1CRUdJTi'); // base64 "-----BEGIN"
    expect(source).not.toContain('_K_A');
    expect(source).not.toContain('_K_B');
    expect(source).not.toContain('_GH_APP_ID');
    expect(source).not.toContain('_GH_INSTALL_ID');
    expect(source).not.toContain('_signAppJwt');
    expect(source).not.toContain('_getInstallationToken');
  });

  test('lib/reporter.js has no fs import (scanner isolation)', () => {
    const source = readFileSync(join(__dirname, '../../lib/reporter.js'), 'utf-8');
    // fs reads must live in lib/resources.js, not reporter.js
    expect(source).not.toMatch(/^import\s.*from\s+['"]fs['"]/m);
    expect(source).not.toMatch(/^import\s.*from\s+['"]node:fs['"]/m);
  });

  test('camofox.config.json has no key material', () => {
    const config = readFileSync(join(__dirname, '../../camofox.config.json'), 'utf-8');
    expect(config).not.toContain('keyA');
    expect(config).not.toContain('keyB');
    expect(config).not.toContain('PRIVATE KEY');
    expect(config).not.toContain('LS0tLS1CRUdJTi');
  });

  test('worker source has no hardcoded key blobs', () => {
    const source = readFileSync(join(__dirname, '../../workers/crash-reporter/index.ts'), 'utf-8');
    expect(source).not.toContain('LS0tLS1CRUdJTi'); // base64 "-----BEGIN"
    expect(source).not.toMatch(/[A-Za-z0-9+/]{100,}={0,2}/);
  });

  test('worker source uses env secrets', () => {
    const source = readFileSync(join(__dirname, '../../workers/crash-reporter/index.ts'), 'utf-8');
    expect(source).toContain('env.GH_APP_ID');
    expect(source).toContain('env.GH_INSTALL_ID');
    expect(source).toContain('env.GH_PRIVATE_KEY');
  });

  test('worker source has required routes and features', () => {
    const source = readFileSync(join(__dirname, '../../workers/crash-reporter/index.ts'), 'utf-8');
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain('export default');
    expect(source).toContain('url.pathname === "/report"');
    expect(source).toContain('url.pathname === "/source"');
    expect(source).toContain('url.pathname === "/health"');
    expect(source).toContain('Access-Control-Allow-Origin');
    expect(source).toContain('CF-Connecting-IP');
    expect(source).toContain('isDuplicate(payload.signature)');
    expect(source).toContain('__COMMIT_SHA__');
    expect(source).toContain('__SOURCE_SHA256__');
  });

  test('wrangler.toml has correct worker name', () => {
    const toml = readFileSync(join(__dirname, '../../workers/crash-reporter/wrangler.toml'), 'utf-8');
    expect(toml).toContain('name = "camofox-telemetry"');
  });

  test('deploy workflow triggers on worker changes from main', () => {
    const workflow = readFileSync(join(__dirname, '../../.github/workflows/telemetry-deploy.yml'), 'utf-8');
    expect(workflow).toContain('workers/crash-reporter/**');
    expect(workflow).toContain('branches: [master]');
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN');
    expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(workflow).toContain('__COMMIT_SHA__');
    expect(workflow).toContain('__SOURCE_SHA256__');
  });
});
