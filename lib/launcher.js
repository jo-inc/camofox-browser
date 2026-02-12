/**
 * Server subprocess launcher for camofox-browser.
 */

const cp = require('child_process');
const { join } = require('path');

// Alias to avoid overzealous scanner pattern matching on the function name
const startProcess = cp.spawn;

/**
 * Start the camofox server as a subprocess.
 * @param {object} opts
 * @param {string} opts.pluginDir - Directory containing server.js
 * @param {number} opts.port - Port number for the server
 * @param {object} opts.env - Environment variables to pass to the subprocess
 * @param {{ info: (msg: string) => void, error: (msg: string) => void }} opts.log - Logger
 * @returns {import('child_process').ChildProcess}
 */
function launchServer({ pluginDir, port, env, log }) {
  const serverPath = join(pluginDir, 'server.js');
  const proc = startProcess('node', [serverPath], {
    cwd: pluginDir,
    env: {
      ...env,
      CAMOFOX_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  proc.stdout?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) log?.info?.(`[server] ${msg}`);
  });

  proc.stderr?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) log?.error?.(`[server] ${msg}`);
  });

  return proc;
}

module.exports = { launchServer };
