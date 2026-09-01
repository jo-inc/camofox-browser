import { describe, expect, test } from '@jest/globals';
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Express routing compatibility', () => {
  test('uses Express 5 routing compatible with a host path-to-regexp 8 override', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    const app = express();

    expect(packageJson.dependencies.express).toMatch(/^\^5\./);
    expect(() => app.get('/tabs/:tabId', () => {})).not.toThrow();
  });
});
