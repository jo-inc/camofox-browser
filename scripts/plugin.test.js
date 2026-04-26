/**
 * Tests for scripts/plugin.js — plugin install, remove, list.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from './exec.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'plugin.js');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const CONFIG_PATH = path.join(ROOT, 'camofox.config.json');

const run = (args) => execSync(`node ${SCRIPT} ${args}`, { cwd: ROOT, encoding: 'utf-8' });

// Save/restore config around tests
let originalConfig;
beforeAll(() => { originalConfig = fs.readFileSync(CONFIG_PATH, 'utf-8'); });
afterAll(() => { fs.writeFileSync(CONFIG_PATH, originalConfig); });

// Clean up test plugins after each test
afterEach(() => {
  const testDir = path.join(PLUGINS_DIR, 'test-plugin');
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  // Restore config
  fs.writeFileSync(CONFIG_PATH, originalConfig);
});

describe('plugin list', () => {
  test('lists youtube as enabled', () => {
    const out = run('list');
    expect(out).toContain('youtube');
    expect(out).toContain('✓');
  });
});

describe('plugin install (local)', () => {
  const tmpDir = path.join(ROOT, '.tmp-test-plugin');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'index.js'),
      'export function register(app, ctx) { app.get("/test", (req, res) => res.json({})); }');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    const installed = path.join(PLUGINS_DIR, '.tmp-test-plugin');
    if (fs.existsSync(installed)) fs.rmSync(installed, { recursive: true });
  });

  test('copies plugin dir and updates config', () => {
    const out = run(`install ${tmpDir}`);
    expect(out).toContain('Installed');

    // Plugin dir exists
    const installed = path.join(PLUGINS_DIR, '.tmp-test-plugin');
    expect(fs.existsSync(installed)).toBe(true);
    expect(fs.existsSync(path.join(installed, 'index.js'))).toBe(true);

    // Config updated
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (Array.isArray(config.plugins)) {
      expect(config.plugins).toContain('.tmp-test-plugin');
    } else {
      expect(config.plugins['.tmp-test-plugin']).toBeDefined();
    }
  });

  test('rejects duplicate install', () => {
    run(`install ${tmpDir}`);
    expect(() => run(`install ${tmpDir}`)).toThrow();
  });
});

describe('plugin remove', () => {
  const tmpDir = path.join(ROOT, '.tmp-test-plugin-rm');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'index.js'),
      'export function register(app, ctx) {}');
    run(`install ${tmpDir}`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    const installed = path.join(PLUGINS_DIR, '.tmp-test-plugin-rm');
    if (fs.existsSync(installed)) fs.rmSync(installed, { recursive: true });
  });

  test('removes plugin dir and config entry', () => {
    const out = run('remove .tmp-test-plugin-rm');
    expect(out).toContain('Removed');

    const installed = path.join(PLUGINS_DIR, '.tmp-test-plugin-rm');
    expect(fs.existsSync(installed)).toBe(false);

    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    expect(config.plugins).not.toContain('.tmp-test-plugin-rm');
  });

  test('errors on unknown plugin', () => {
    expect(() => run('remove nonexistent-plugin-xyz')).toThrow();
  });
});

describe('plugin help', () => {
  test('shows usage with no args', () => {
    const out = run('');
    expect(out).toContain('Usage');
    expect(out).toContain('install');
    expect(out).toContain('remove');
  });
});
