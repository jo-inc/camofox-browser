#!/usr/bin/env node
// Writes a local .env for a Camofox server. The access key is read from the
// environment or a prompt, written to .env with mode 600, and never printed.
//
//   node setup-env.mjs --base-url https://your-server.example.com [--force]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const baseUrl = (opt('--base-url') || process.env.CAMOFOX_BASE_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+/.test(baseUrl)) {
  console.error('Pass --base-url https://<your-server> (no trailing slash).');
  process.exit(2);
}
if (baseUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl)) {
  console.error('Refusing a non-local http:// base URL. Use https://.');
  process.exit(2);
}

const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile) && !flag('--force')) {
  console.error(`${envFile} already exists. Re-run with --force to replace it.`);
  process.exit(2);
}

let key = process.env.CAMOFOX_ACCESS_KEY || '';
if (!key) {
  if (!stdin.isTTY) {
    console.error('Set CAMOFOX_ACCESS_KEY in the environment (no terminal to prompt on).');
    process.exit(2);
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  key = (await rl.question('CAMOFOX_ACCESS_KEY (input is shown; paste from Railway Variables): ')).trim();
  rl.close();
}
if (key.length < 24) {
  console.error('That key looks too short. Copy the full CAMOFOX_ACCESS_KEY from the server settings.');
  process.exit(2);
}

const body = [
  '# Camofox client settings. Local only. Never commit this file.',
  `CAMOFOX_BASE_URL=${baseUrl}`,
  `CAMOFOX_ACCESS_KEY=${key}`,
  '',
].join('\n');
fs.writeFileSync(envFile, body, { mode: 0o600 });
fs.chmodSync(envFile, 0o600);

const gitignore = path.resolve(process.cwd(), '.gitignore');
const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
if (!/^\.env$/m.test(existing)) {
  fs.appendFileSync(gitignore, `${existing && !existing.endsWith('\n') ? '\n' : ''}.env\n`);
}
console.log(`Wrote ${envFile} (mode 600). Base URL: ${baseUrl}. Key: saved, not shown.`);
console.log('Next: node scripts/check-server.mjs');
