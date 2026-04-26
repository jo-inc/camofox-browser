#!/usr/bin/env node

/**
 * camofox plugin manager — install, remove, and list plugins.
 *
 * Usage:
 *   node scripts/plugin.js install <source>   Install a plugin from git URL or local path
 *   node scripts/plugin.js remove <name>      Remove a plugin and its config entry
 *   node scripts/plugin.js list               List installed plugins and their source
 *
 * Sources:
 *   git:github.com/user/repo                  Git shorthand
 *   https://github.com/user/repo              Git URL
 *   /absolute/path/to/plugin-dir              Local directory (copied)
 *   ./relative/path/to/plugin-dir             Local directory (copied)
 *
 * Plugin name is inferred from the repo/directory name. If the repo root has
 * an index.js with register(), it's used directly. If it has a plugins/ subdir,
 * each subdirectory is installed as a separate plugin.
 *
 * After install, the plugin is added to camofox.config.json plugins[] and
 * npm dependencies are installed if the plugin has a package.json.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from './exec.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const CONFIG_PATH = path.join(ROOT, 'camofox.config.json');

// ── Config helpers ──────────────────────────────────────────────────────────

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { id: 'camofox-browser', name: 'Camofox Browser', version: '0.0.0', plugins: [] };
  }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Get the set of enabled plugin names from config.
 * Handles both array format ["youtube"] and object format { "youtube": { "enabled": true } }.
 */
function getEnabledPlugins(config) {
  if (!config.plugins) return new Set();
  if (Array.isArray(config.plugins)) return new Set(config.plugins);
  if (typeof config.plugins === 'object') {
    const enabled = new Set();
    for (const [name, conf] of Object.entries(config.plugins)) {
      if (conf === false || (typeof conf === 'object' && conf.enabled === false)) continue;
      enabled.add(name);
    }
    return enabled;
  }
  return new Set();
}

function addToConfig(name) {
  const config = readConfig();
  if (Array.isArray(config.plugins)) {
    if (!config.plugins.includes(name)) {
      config.plugins.push(name);
      writeConfig(config);
    }
  } else if (typeof config.plugins === 'object') {
    if (!config.plugins[name] || config.plugins[name].enabled === false) {
      config.plugins[name] = config.plugins[name] || {};
      config.plugins[name].enabled = true;
      writeConfig(config);
    }
  } else {
    config.plugins = [name];
    writeConfig(config);
  }
}

function removeFromConfig(name) {
  const config = readConfig();
  if (Array.isArray(config.plugins)) {
    config.plugins = config.plugins.filter(p => p !== name);
    writeConfig(config);
  } else if (typeof config.plugins === 'object' && config.plugins[name] !== undefined) {
    delete config.plugins[name];
    writeConfig(config);
  }
}

// ── Source parsing ──────────────────────────────────────────────────────────

function parseSource(source) {
  // Local path
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) {
    const resolved = path.resolve(source);
    if (!fs.existsSync(resolved)) {
      fatal(`Local path not found: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      fatal(`Source must be a directory: ${resolved}`);
    }
    return { type: 'local', path: resolved, name: path.basename(resolved) };
  }

  // Git URL — https://, ssh://, git@, git:
  let gitUrl = source;
  if (gitUrl.startsWith('git:')) {
    gitUrl = gitUrl.slice(4);
    // git:github.com/user/repo → https://github.com/user/repo
    if (!gitUrl.startsWith('http') && !gitUrl.startsWith('ssh://') && !gitUrl.startsWith('git@')) {
      gitUrl = `https://${gitUrl}`;
    }
  }

  // Strip trailing .git
  gitUrl = gitUrl.replace(/\.git$/, '');

  // Extract name from URL
  const name = gitUrl.split('/').pop().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) fatal(`Cannot infer plugin name from: ${source}`);

  // Re-add .git for clone
  const cloneUrl = gitUrl.endsWith('.git') ? gitUrl : `${gitUrl}.git`;

  return { type: 'git', url: cloneUrl, name };
}

// ── Install ─────────────────────────────────────────────────────────────────

function isPluginDir(dir) {
  const indexPath = path.join(dir, 'index.js');
  if (!fs.existsSync(indexPath)) return false;
  const content = fs.readFileSync(indexPath, 'utf-8');
  return /\bregister\b/.test(content);
}

function installFromLocal(srcDir, name) {
  const destDir = path.join(PLUGINS_DIR, name);
  if (fs.existsSync(destDir)) {
    fatal(`Plugin "${name}" already exists. Remove it first: node scripts/plugin.js remove ${name}`);
  }
  copyDirSync(srcDir, destDir);
  return [name];
}

function installFromGit(url, name) {
  const tmpDir = path.join(ROOT, '.tmp-plugin-clone');
  try {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });

    console.log(`Cloning ${url}...`);
    execSync(`git clone --depth 1 ${url} ${tmpDir}`, { stdio: 'pipe' });

    // Case 1: Root is a plugin (has index.js with register)
    if (isPluginDir(tmpDir)) {
      return installFromLocal(tmpDir, name);
    }

    // Case 2: Has plugins/ subdir with plugin directories
    const pluginsSubdir = path.join(tmpDir, 'plugins');
    if (fs.existsSync(pluginsSubdir) && fs.statSync(pluginsSubdir).isDirectory()) {
      const installed = [];
      for (const entry of fs.readdirSync(pluginsSubdir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        const subDir = path.join(pluginsSubdir, entry.name);
        if (isPluginDir(subDir)) {
          installFromLocal(subDir, entry.name);
          installed.push(entry.name);
        }
      }
      if (installed.length === 0) {
        fatal(`No plugins found in ${url} — expected index.js with register() at root or in plugins/*/`);
      }
      return installed;
    }

    fatal(`No plugins found in ${url} — expected index.js with register() at root or plugins/*/ subdirs`);
  } finally {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  }
}

function installPluginDeps(name) {
  const pluginDir = path.join(PLUGINS_DIR, name);

  // npm install if package.json exists
  const pkgJson = path.join(pluginDir, 'package.json');
  if (fs.existsSync(pkgJson)) {
    console.log(`Installing npm dependencies for ${name}...`);
    execSync('npm install --omit=dev', { cwd: pluginDir, stdio: 'inherit' });
  }

  // Check for apt.txt / post-install.sh (just warn — can't run apt locally)
  if (fs.existsSync(path.join(pluginDir, 'apt.txt'))) {
    console.log(`⚠  ${name} has apt.txt — system packages need Docker build or manual install`);
  }
  if (fs.existsSync(path.join(pluginDir, 'post-install.sh'))) {
    console.log(`⚠  ${name} has post-install.sh — run it manually or rebuild Docker image`);
  }
}

// ── Remove ──────────────────────────────────────────────────────────────────

function removePlugin(name) {
  const pluginDir = path.join(PLUGINS_DIR, name);
  if (!fs.existsSync(pluginDir)) {
    fatal(`Plugin "${name}" not found in plugins/`);
  }

  fs.rmSync(pluginDir, { recursive: true });
  removeFromConfig(name);
  console.log(`✓ Removed plugin "${name}"`);
}

// ── List ────────────────────────────────────────────────────────────────────

function listPlugins() {
  const config = readConfig();
  const configPlugins = getEnabledPlugins(config);

  if (!fs.existsSync(PLUGINS_DIR)) {
    console.log('No plugins directory.');
    return;
  }

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const plugins = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map(e => e.name);

  if (plugins.length === 0) {
    console.log('No plugins installed.');
    return;
  }

  console.log('Installed plugins:\n');
  for (const name of plugins.sort()) {
    const enabled = configPlugins.size === 0 || configPlugins.has(name);
    const status = enabled ? '✓' : '○';
    const hasTest = fs.existsSync(path.join(PLUGINS_DIR, name, `${name}.test.js`))
      || fs.readdirSync(path.join(PLUGINS_DIR, name)).some(f => f.endsWith('.test.js'));
    const hasDeps = fs.existsSync(path.join(PLUGINS_DIR, name, 'apt.txt'))
      || fs.existsSync(path.join(PLUGINS_DIR, name, 'post-install.sh'));
    const hasPkg = fs.existsSync(path.join(PLUGINS_DIR, name, 'package.json'));

    const flags = [
      hasTest ? 'tests' : null,
      hasDeps ? 'sys-deps' : null,
      hasPkg ? 'npm-deps' : null,
    ].filter(Boolean).join(', ');

    console.log(`  ${status} ${name}${flags ? `  (${flags})` : ''}`);
  }

  if (configPlugins.size > 0) {
    console.log(`\n${configPlugins.size} plugin(s) enabled in camofox.config.json`);
  } else {
    console.log('\nNo plugins[] in config — all plugins are loaded');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    // Skip .git, node_modules
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function fatal(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const [,, action, ...args] = process.argv;

switch (action) {
  case 'install': {
    const source = args[0];
    if (!source) fatal('Usage: plugin install <git-url|local-path>');

    const parsed = parseSource(source);
    const installed = parsed.type === 'git'
      ? installFromGit(parsed.url, parsed.name)
      : installFromLocal(parsed.path, parsed.name);

    for (const name of installed) {
      addToConfig(name);
      installPluginDeps(name);
    }

    console.log(`\n✓ Installed: ${installed.join(', ')}`);
    console.log('  Restart the server to load new plugin(s).');
    break;
  }

  case 'remove': {
    const name = args[0];
    if (!name) fatal('Usage: plugin remove <name>');
    removePlugin(name);
    break;
  }

  case 'list':
  case 'ls': {
    listPlugins();
    break;
  }

  default:
    console.log(`camofox plugin manager

Usage:
  node scripts/plugin.js install <source>   Install from git URL or local path
  node scripts/plugin.js remove <name>      Remove a plugin
  node scripts/plugin.js list               List installed plugins

Sources:
  git:github.com/user/repo
  https://github.com/user/repo
  ./path/to/local/plugin`);
    if (action) process.exit(1);
}
