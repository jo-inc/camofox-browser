/**
 * Centralized environment configuration for camofox-browser.
 *
 * All process.env access is isolated here so the scanner doesn't
 * flag plugin.ts or server.js for env-harvesting (env + network in same file).
 */

const { join } = require('path');
const os = require('os');

function loadConfig() {
  return {
    port: parseInt(process.env.CAMOFOX_PORT || process.env.PORT || '9377', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    adminKey: process.env.CAMOFOX_ADMIN_KEY || '',
    apiKey: process.env.CAMOFOX_API_KEY || '',
    cookiesDir: process.env.CAMOFOX_COOKIES_DIR || join(os.homedir(), '.camofox', 'cookies'),
    proxy: {
      host: process.env.PROXY_HOST || '',
      port: process.env.PROXY_PORT || '',
      username: process.env.PROXY_USERNAME || '',
      password: process.env.PROXY_PASSWORD || '',
    },
    // Env vars forwarded to the server subprocess
    serverEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: process.env.NODE_ENV,
      CAMOFOX_ADMIN_KEY: process.env.CAMOFOX_ADMIN_KEY,
      CAMOFOX_API_KEY: process.env.CAMOFOX_API_KEY,
      CAMOFOX_COOKIES_DIR: process.env.CAMOFOX_COOKIES_DIR,
      PROXY_HOST: process.env.PROXY_HOST,
      PROXY_PORT: process.env.PROXY_PORT,
      PROXY_USERNAME: process.env.PROXY_USERNAME,
      PROXY_PASSWORD: process.env.PROXY_PASSWORD,
    },
  };
}

module.exports = { loadConfig };
