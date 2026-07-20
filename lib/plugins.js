/**
 * Camofox-browser plugin system.
 *
 * Plugins live in plugins/<name>/index.js and export a register(app, ctx) function.
 * The ctx object provides access to sessions, config, logging, auth middleware,
 * core functions, and an EventEmitter for lifecycle hooks.
 *
 * 29 events across 7 categories:
 *
 *   BROWSER LIFECYCLE
 *     browser:launching       { options }                      -- mutate launch options
 *     browser:launched        { browser, display }             -- after launch
 *     browser:restart         { reason }                       -- before restart cycle
 *     browser:closed          { reason }                       -- after browser closed
 *     browser:error           { error }                        -- uncaught browser error
 *
 *   SESSION LIFECYCLE
 *     session:creating        { userId, contextOptions }       -- mutate context options
 *     session:created         { userId, context }              -- after context stored
 *     session:destroying      { userId, reason }               -- before context close (context still alive)
 *     session:destroyed       { userId, reason }               -- after cleanup
 *     session:expired         { userId, idleMs }               -- reaper triggered
 *
 *   TAB LIFECYCLE
 *     tab:created             { userId, tabId, page, url }
 *     tab:navigated           { userId, tabId, url, prevUrl }
 *     tab:destroyed           { userId, tabId, reason }
 *     tab:recycled            { userId, tabId }
 *     tab:error               { userId, tabId, error }
 *
 *   CONTENT
 *     tab:snapshot            { userId, tabId, snapshot }
 *     tab:screenshot          { userId, tabId, buffer }
 *     tab:evaluate            { userId, tabId, expression }
 *     tab:evaluated           { userId, tabId, result }
 *
 *   INPUT
 *     tab:click               { userId, tabId, ref, selector }
 *     tab:type                { userId, tabId, text, ref, mode }
 *     tab:scroll              { userId, tabId, direction, amount }
 *     tab:press               { userId, tabId, key }
 *
 *   DOWNLOADS
 *     tab:download:start      { userId, tabId, filename, url }
 *     tab:download:complete   { userId, tabId, filename, path, size }
 *
 *   COOKIES / AUTH
 *     session:cookies:import  { userId, count }
 *     session:storage:export  { userId, storageState }
 *
 *   SERVER
 *     server:starting         { port }
 *     server:started          { port, pid }
 *     server:shutdown         { signal }
 *
 * Mutating hooks (browser:launching, session:creating) pass the options object
 * by reference -- plugins can modify it in place before core uses it.
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const CONFIG_PATH = path.join(ROOT_DIR, 'camofox.config.json');

function envFlagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function readPluginMetadata(pluginsDir, name) {
  try {
    const raw = fs.readFileSync(path.join(pluginsDir, name, 'plugin.json'), 'utf-8');
    const metadata = JSON.parse(raw);
    return metadata && typeof metadata === 'object' ? metadata : {};
  } catch {
    return {};
  }
}

function pluginEnabledByEnv(metadata, env) {
  const { enableEnvVar } = metadata;
  return typeof enableEnvVar === 'string' && enableEnvVar.length > 0 && envFlagEnabled(env[enableEnvVar]);
}

/**
 * Read plugin configuration from camofox.config.json.
 * Supports two formats:
 *   - Array of strings: ["youtube", "persistence"] (no per-plugin config)
 *   - Object with per-plugin config: { "youtube": { "enabled": true }, "persistence": { "enabled": true, "profileDir": "/data" } }
 * Returns { list: string[] | null, configs: Map<string, object> }
 */
function readPluginConfig(configPath = CONFIG_PATH) {
  const configs = new Map();
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    if (!config.plugins) return { list: null, configs };
    if (Array.isArray(config.plugins)) {
      return { list: config.plugins, configs };
    }
    if (typeof config.plugins === 'object') {
      const list = [];
      for (const [name, pluginConf] of Object.entries(config.plugins)) {
        const isObjectConfig = pluginConf && typeof pluginConf === 'object';
        if (isObjectConfig) configs.set(name, pluginConf);
        if (pluginConf === false || (isObjectConfig && pluginConf.enabled === false)) continue;
        list.push(name);
      }
      return { list, configs };
    }
  } catch {}
  return { list: null, configs };
}

/**
 * Create the plugin event bus.
 */
export function createPluginEvents() {
  const events = new EventEmitter();
  events.setMaxListeners(50); // generous for many plugins

  /**
   * Emit an event and await all listeners (including async ones).
   * Use for mutating hooks where plugins must finish before core continues.
   * Regular emit() is still used for fire-and-forget observational events.
   */
  events.emitAsync = async function emitAsync(eventName, payload) {
    const listeners = this.listeners(eventName);
    await Promise.all(listeners.map(fn => fn(payload)));
  };

  return events;
}

/**
 * Load and register all plugins from plugins/<name>/index.js.
 *
 * @param {object} app - Express app
 * @param {object} ctx - Plugin context: { sessions, config, log, events, auth, ensureBrowser, getSession, destroySession }
 *                       Mutable -- plugins can replace ctx.createVirtualDisplay etc.
 * @returns {string[]} - Names of loaded plugins
 */
export async function loadPlugins(app, ctx, options = {}) {
  const loaded = [];
  const pluginsDir = options.pluginsDir || PLUGINS_DIR;
  const configPath = options.configPath || CONFIG_PATH;
  const env = options.env || ctx.config?.pluginEnv || {};

  if (!fs.existsSync(pluginsDir)) {
    ctx.log('info', 'no plugins directory found, skipping plugin load');
    return loaded;
  }

  const { list: allowList, configs: pluginConfigs } = readPluginConfig(configPath);
  // Expose resolved per-plugin configuration so plugins that share an API
  // contract (for example persistence and VNC storage export) stay consistent.
  ctx.pluginConfigs = pluginConfigs;
  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    // Skip directories starting with _ or .
    if (name.startsWith('_') || name.startsWith('.')) continue;

    // If camofox.config.json specifies a plugins list, only load those
    if (allowList && !allowList.includes(name)) {
      const metadata = readPluginMetadata(pluginsDir, name);
      if (pluginEnabledByEnv(metadata, env)) {
        ctx.log('info', 'plugin enabled by environment', { plugin: name, envVar: metadata.enableEnvVar });
      } else {
        ctx.log('debug', `plugin "${name}" not in camofox.config.json plugins list, skipping`);
        continue;
      }
    }

    const indexPath = path.join(pluginsDir, name, 'index.js');
    if (!fs.existsSync(indexPath)) {
      ctx.log('warn', `plugin "${name}" has no index.js, skipping`);
      continue;
    }

    try {
      const mod = await import(pathToFileURL(indexPath).href);
      const register = mod.default || mod.register;
      if (typeof register !== 'function') {
        ctx.log('warn', `plugin "${name}" does not export a register function, skipping`);
        continue;
      }

      const pluginConfig = pluginConfigs.get(name) || {};
      await register(app, ctx, pluginConfig);
      loaded.push(name);
      ctx.log('info', 'plugin loaded', { plugin: name });
    } catch (err) {
      ctx.log('error', 'plugin load failed', { plugin: name, error: err.message, stack: err.stack });
    }
  }

  return loaded;
}
