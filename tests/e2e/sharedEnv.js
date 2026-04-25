/**
 * Helper to read shared server URLs from globalSetup.
 * Used by e2e test files instead of starting their own server.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const ENV_FILE = path.join(os.tmpdir(), 'camofox-e2e-env.json');

let cached = null;

export function getSharedEnv() {
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(ENV_FILE, 'utf-8'));
  }
  return cached;
}
