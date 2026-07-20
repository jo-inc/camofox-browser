/**
 * Tests for the /tabs/:tabId/upload endpoint.
 *
 * The route is deeply embedded in server.js and can't be extracted without an
 * invasive refactor, so (following the project convention in
 * typeKeyboardMode.test.js / navigationTimeout.test.js) we test in two ways:
 *
 *   1. A mirrored copy of the request-validation logic, kept in sync with the
 *      route. If this diverges, integration use will catch it.
 *   2. Source-contract assertions: read server.js and assert the route exists
 *      and preserves its load-bearing behaviors (two-strategy attach, container
 *      file-existence guard, no OS dialog dependency).
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, '../../server.js'), 'utf8');

/**
 * Extracted validation logic matching the /upload endpoint in server.js.
 * Kept in sync with the route -- if this diverges, integration tests will catch it.
 *
 * Returns { status, error } for an early validation failure, or null if the
 * request passes validation (assuming the files exist in the container).
 */
function validateUploadRequest({ userId, path: filePath, ref, selector }, fileExists = () => true) {
  if (!userId) return { status: 400, error: 'userId required' };
  if (!filePath) return { status: 400, error: 'path required (container-side file path)' };

  const paths = Array.isArray(filePath) ? filePath : [filePath];
  for (const p of paths) {
    if (typeof p !== 'string' || !p) return { status: 400, error: 'path entries must be non-empty strings' };
    if (!fileExists(p)) return { status: 400, error: `file not found in container: ${p}`, code: 'file_not_found' };
  }
  return null;
}

describe('/upload request validation', () => {
  test('requires userId', () => {
    const r = validateUploadRequest({ path: '/tmp/a.png' });
    expect(r).toMatchObject({ status: 400, error: 'userId required' });
  });

  test('requires path', () => {
    const r = validateUploadRequest({ userId: 'agent1' });
    expect(r).toMatchObject({ status: 400, error: expect.stringContaining('path required') });
  });

  test('accepts a single string path that exists', () => {
    const r = validateUploadRequest({ userId: 'agent1', path: '/data/x.png' }, () => true);
    expect(r).toBeNull();
  });

  test('accepts an array of paths', () => {
    const r = validateUploadRequest({ userId: 'agent1', path: ['/data/a.png', '/data/b.png'] }, () => true);
    expect(r).toBeNull();
  });

  test('rejects a non-string path entry', () => {
    const r = validateUploadRequest({ userId: 'agent1', path: [123] }, () => true);
    expect(r).toMatchObject({ status: 400, error: expect.stringContaining('non-empty strings') });
  });

  test('rejects a path that is not present in the container', () => {
    const r = validateUploadRequest({ userId: 'agent1', path: '/nope.png' }, () => false);
    expect(r).toMatchObject({ status: 400, code: 'file_not_found' });
  });

  test('ref/selector are optional (an existing input[type=file] needs no trigger)', () => {
    const r = validateUploadRequest({ userId: 'agent1', path: '/data/x.png' }, () => true);
    expect(r).toBeNull();
  });
});

describe('/upload source contract', () => {
  test('the route is registered', () => {
    expect(serverSrc).toMatch(/app\.post\(\s*['"]\/tabs\/:tabId\/upload['"]/);
  });

  test('guards against files missing inside the container', () => {
    expect(serverSrc).toMatch(/fs\.existsSync/);
    expect(serverSrc).toMatch(/file_not_found/);
  });

  test('strategy 1 sets files directly on an existing input[type=file]', () => {
    expect(serverSrc).toMatch(/setInputFiles/);
    expect(serverSrc).toMatch(/input\[type="file"\]/);
    expect(serverSrc).toMatch(/direct_input/);
  });

  test('strategy 2 arms a filechooser and activates via keyboard then forced click', () => {
    expect(serverSrc).toMatch(/waitForEvent\(\s*['"]filechooser['"]/);
    expect(serverSrc).toMatch(/keyboard\.press\(\s*['"]Enter['"]\s*\)/);
    expect(serverSrc).toMatch(/force:\s*true/);
    expect(serverSrc).toMatch(/setFiles\(/);
  });

  test('runs under the per-user and per-tab locks like the other interaction routes', () => {
    const idx = serverSrc.indexOf("app.post('/tabs/:tabId/upload'");
    const slice = serverSrc.slice(idx, idx + 4000);
    expect(slice).toMatch(/withUserLimit\(/);
    expect(slice).toMatch(/withTabLock\(/);
  });
});
