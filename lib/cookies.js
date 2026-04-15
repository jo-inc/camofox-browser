/**
 * Cookie file reading and parsing for camofox-browser.
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Parse a Netscape-format cookie file into structured cookie objects.
 * @param {string} text - Raw cookie file content
 * @returns {Array<{name: string, value: string, domain: string, path: string, expires: number, httpOnly?: boolean, secure?: boolean}>}
 */
function parseNetscapeCookieFile(text) {
  const cookies = [];
  const cleaned = text.replace(/^\uFEFF/, '');

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;

    let httpOnly = false;
    let working = line;
    if (working.startsWith('#HttpOnly_')) {
      httpOnly = true;
      working = working.replace(/^#HttpOnly_/, '');
    }

    const parts = working.split('\t');
    if (parts.length < 7) continue;

    const domain = parts[0];
    const cookiePath = parts[2];
    const secure = parts[3].toUpperCase() === 'TRUE';
    const expires = Number(parts[4]);
    const name = parts[5];
    const value = parts.slice(6).join('\t');

    cookies.push({ name, value, domain, path: cookiePath, expires, httpOnly, secure });
  }

  return cookies;
}

/**
 * Read and parse cookies from a Netscape cookie file.
 * @param {object} opts
 * @param {string} opts.cookiesDir - Base directory for cookie files
 * @param {string} opts.cookiesPath - Relative path to the cookie file within cookiesDir
 * @param {string} [opts.domainSuffix] - Only include cookies whose domain ends with this suffix
 * @param {number} [opts.maxBytes=5242880] - Maximum file size in bytes
 * @returns {Promise<Array<{name: string, value: string, domain: string, path: string, expires: number, httpOnly: boolean, secure: boolean}>>}
 */
async function readCookieFile({ cookiesDir, cookiesPath, domainSuffix, maxBytes = 5 * 1024 * 1024 }) {
  const resolved = path.resolve(cookiesDir, cookiesPath);
  if (!resolved.startsWith(cookiesDir + path.sep)) {
    throw new Error('cookiesPath must be a relative path within the cookies directory');
  }

  const stat = await fs.stat(resolved);
  if (stat.size > maxBytes) {
    throw new Error('Cookie file too large (max 5MB)');
  }

  const text = await fs.readFile(resolved, 'utf8');
  let cookies = parseNetscapeCookieFile(text);
  if (domainSuffix) {
    cookies = cookies.filter((c) => c.domain.endsWith(domainSuffix));
  }

  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
  }));
}

/**
 * Import all cookies from the default bootstrap cookie file into a Playwright context.
 * Intended for first-run session seeding before any persistent storage state exists.
 * Missing file is treated as a no-op.
 * @param {object} opts
 * @param {string} opts.cookiesDir - Base directory for cookie files
 * @param {object} opts.context - Playwright BrowserContext
 * @param {string} [opts.cookiesPath='cookies.txt'] - Relative cookie file path within cookiesDir
 * @param {object} [opts.logger=console] - Logger with warn()
 * @returns {Promise<{imported: number, source: string|null}>}
 */
async function importBootstrapCookies({ cookiesDir, context, cookiesPath = 'cookies.txt', logger = console }) {
  if (!cookiesDir || !context) {
    return { imported: 0, source: null };
  }

  const resolved = path.resolve(cookiesDir, cookiesPath);

  try {
    const cookies = await readCookieFile({ cookiesDir, cookiesPath });
    if (cookies.length === 0) {
      return { imported: 0, source: resolved };
    }
    await context.addCookies(cookies);
    return { imported: cookies.length, source: resolved };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { imported: 0, source: null };
    }
    logger?.warn?.('failed to import bootstrap cookies', {
      cookiesPath: resolved,
      error: err?.message || String(err),
    });
    return { imported: 0, source: resolved };
  }
}

export { parseNetscapeCookieFile, readCookieFile, importBootstrapCookies };
