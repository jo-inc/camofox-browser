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
 *     browser:launching       { options }                      — mutate launch options
 *     browser:launched        { browser, display }             — after launch
 *     browser:restart         { reason }                       — before restart cycle
 *     browser:closed          { reason }                       — after browser closed
 *     browser:error           { error }                        — uncaught browser error
 *
 *   SESSION LIFECYCLE
 *     session:creating        { userId, contextOptions }       — mutate context options
 *     session:created         { userId, context }              — after context stored
 *     session:destroyed       { userId, reason }               — after cleanup
 *     session:expired         { userId, idleMs }               — reaper triggered
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
 *     session:storage:export  { userId }
 *
 *   SERVER
 *     server:starting         { port }
 *     server:started          { port, pid }
 *     server:shutdown         { signal }
 *
 * Mutating hooks (browser:launching, session:creating) pass the options object
 * by reference — plugins can modify it in place before core uses it.
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

/**
 * Create the plugin event bus.
 */
export function createPluginEvents() {
  const events = new EventEmitter();
  events.setMaxListeners(50); // generous for many plugins
  return events;
}

/**
 * Load and register all plugins from plugins/<name>/index.js.
 *
 * @param {object} app - Express app
 * @param {object} ctx - Plugin context: { sessions, config, log, events, auth, ensureBrowser, getSession, destroySession }
 * @returns {string[]} - Names of loaded plugins
 */
export async function loadPlugins(app, ctx) {
  const loaded = [];

  if (!fs.existsSync(PLUGINS_DIR)) {
    ctx.log('info', 'no plugins directory found, skipping plugin load');
    return loaded;
  }

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    // Skip directories starting with _ or .
    if (name.startsWith('_') || name.startsWith('.')) continue;

    const indexPath = path.join(PLUGINS_DIR, name, 'index.js');
    if (!fs.existsSync(indexPath)) {
      ctx.log('warn', `plugin "${name}" has no index.js, skipping`);
      continue;
    }

    try {
      const mod = await import(indexPath);
      const register = mod.default || mod.register;
      if (typeof register !== 'function') {
        ctx.log('warn', `plugin "${name}" does not export a register function, skipping`);
        continue;
      }

      await register(app, ctx);
      loaded.push(name);
      ctx.log('info', 'plugin loaded', { plugin: name });
    } catch (err) {
      ctx.log('error', 'plugin load failed', { plugin: name, error: err.message, stack: err.stack });
    }
  }

  return loaded;
}
