// Shared setup for the live test scripts: reads CAMOFOX_BASE_URL and
// CAMOFOX_ACCESS_KEY from the environment or .env, and provides a small HTTP helper.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

export const BASE = (process.env.CAMOFOX_BASE_URL || '').trim().replace(/\/+$/, '');
export const ACCESS_KEY = (process.env.CAMOFOX_ACCESS_KEY || process.env.CAMOFOX_API_KEY || '').trim();

if (!BASE) throw new Error('Missing CAMOFOX_BASE_URL (set it in .env or the environment).');
if (!ACCESS_KEY) throw new Error('Missing CAMOFOX_ACCESS_KEY (set it in .env or the environment).');

export async function call(path, { method = 'GET', body, key = ACCESS_KEY, timeoutMs = 30_000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

export function makeReporter() {
  let failures = 0;
  const rows = [];
  return {
    check(name, ok, detail = '') {
      if (!ok) failures += 1;
      rows.push({ name, ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
    },
    finish() {
      console.log(failures === 0 ? `\nAll ${rows.length} checks passed.` : `\n${failures} of ${rows.length} check(s) failed.`);
      process.exitCode = failures === 0 ? 0 : 1;
    },
  };
}
