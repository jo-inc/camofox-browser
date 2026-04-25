/**
 * Integration tests for trace API endpoints.
 *
 * Spins up a minimal Express app with the 3 trace routes + POST /tabs (mocked session layer)
 * to test HTTP-level behavior without requiring a real browser.
 *
 * Covers:
 * - GET  /sessions/:userId/traces       — list trace zips
 * - GET  /sessions/:userId/traces/:file  — stream a trace zip
 * - DELETE /sessions/:userId/traces/:file — remove a trace
 * - POST /tabs with trace: true          — session creation with tracing
 * - 409 when adding trace to existing non-traced session
 */

import { jest } from '@jest/globals';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  ensureTracesDir,
  resolveTracePath,
  listUserTraces,
  statTrace,
  deleteTrace,
  makeTraceFilename,
  tracePathFor,
} from '../../lib/tracing.js';
import { requireAuth } from '../../lib/auth.js';

function makeTempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-trace-api-'));
}

function normalizeUserId(id) {
  return String(id);
}

/**
 * Build a lightweight Express app that mirrors the real trace routes in server.js
 * but replaces browser/session logic with a simple in-memory map.
 */
function buildApp(tracesDir) {
  const app = express();
  app.use(express.json());

  // Auth middleware — same as real server. No apiKey + non-production = loopback allowed.
  const config = { apiKey: null, nodeEnv: 'test' };
  const auth = () => requireAuth(config);

  // Minimal session store: userId → { tracePath }
  const sessions = new Map();

  // POST /tabs — simplified version that creates/reuses sessions
  app.post('/tabs', async (req, res) => {
    try {
      const { userId, sessionKey, trace } = req.body;
      if (!userId || !sessionKey) {
        return res.status(400).json({ error: 'userId and sessionKey required' });
      }
      const key = normalizeUserId(userId);
      const existing = sessions.get(key);

      if (trace && existing && !existing.tracePath) {
        return res.status(409).json({
          error: 'trace must be set on session creation. DELETE /sessions/:userId first to restart with tracing.',
        });
      }

      if (!existing) {
        let tracePath = null;
        if (trace) {
          ensureTracesDir(tracesDir, key);
          tracePath = tracePathFor(tracesDir, key, makeTraceFilename());
          // Simulate tracing.start by writing a placeholder zip
          fs.writeFileSync(tracePath, Buffer.from('PK\x03\x04placeholder'));
        }
        const session = {
          tracePath,
          context: {
            tracing: {
              start: async () => {},
              stop: async ({ path: p }) => {
                if (p) fs.writeFileSync(p, Buffer.from('PK\x03\x04tracedata'));
              },
            },
          },
        };
        sessions.set(key, session);
      }

      res.json({ tabId: crypto.randomUUID(), url: 'about:blank' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /sessions/:userId/traces
  app.get('/sessions/:userId/traces', auth(), async (req, res) => {
    try {
      const userId = normalizeUserId(req.params.userId);
      const traces = await listUserTraces(tracesDir, userId);
      res.json({ traces });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /sessions/:userId/traces/:filename
  app.get('/sessions/:userId/traces/:filename', auth(), async (req, res) => {
    try {
      const userId = normalizeUserId(req.params.userId);
      const full = resolveTracePath(tracesDir, userId, req.params.filename);
      if (!full) return res.status(400).json({ error: 'invalid filename' });
      const st = await statTrace(full);
      if (!st) return res.status(404).json({ error: 'not found' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(st.size));
      const stream = fs.createReadStream(full);
      stream.on('error', (err) => {
        if (!res.headersSent) res.status(404).json({ error: 'not found' });
        else res.destroy();
      });
      stream.pipe(res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /sessions/:userId/traces/:filename
  app.delete('/sessions/:userId/traces/:filename', auth(), async (req, res) => {
    try {
      const userId = normalizeUserId(req.params.userId);
      const full = resolveTracePath(tracesDir, userId, req.params.filename);
      if (!full) return res.status(400).json({ error: 'invalid filename' });
      try {
        await deleteTrace(full);
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
        throw err;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return { app, sessions };
}

describe('trace API endpoints', () => {
  let baseDir;
  let server;
  let baseUrl;
  let appSessions;
  const userId = 'trace-test-user';

  beforeAll(async () => {
    baseDir = makeTempBase();
    const { app, sessions } = buildApp(baseDir);
    appSessions = sessions;
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  afterEach(() => {
    appSessions.clear();
  });

  async function req(method, path, body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${baseUrl}${path}`, opts);
    return resp;
  }

  // ── POST /tabs with trace ──

  test('POST /tabs with trace: true creates a session and trace file', async () => {
    const resp = await req('POST', '/tabs', { userId, sessionKey: 's1', trace: true });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.tabId).toBeDefined();

    // Trace file should exist in user's traces dir
    const traces = await listUserTraces(baseDir, userId);
    expect(traces.length).toBe(1);
    expect(traces[0].filename).toMatch(/^trace-.*\.zip$/);
    expect(traces[0].sizeBytes).toBeGreaterThan(0);
  });

  test('POST /tabs with trace: true on existing non-traced session returns 409', async () => {
    // Create session without tracing
    const r1 = await req('POST', '/tabs', { userId: 'u409', sessionKey: 's1' });
    expect(r1.status).toBe(200);

    // Try to add tracing to existing session
    const r2 = await req('POST', '/tabs', { userId: 'u409', sessionKey: 's1', trace: true });
    expect(r2.status).toBe(409);
    const data = await r2.json();
    expect(data.error).toContain('trace must be set on session creation');
  });

  // ── GET /sessions/:userId/traces ──

  test('GET /sessions/:userId/traces returns empty list when no traces exist', async () => {
    const resp = await req('GET', `/sessions/nobody/traces`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.traces).toEqual([]);
  });

  test('GET /sessions/:userId/traces lists trace files sorted newest first', async () => {
    const dir = ensureTracesDir(baseDir, 'list-user');

    // Create two trace files with different mtimes
    const old = path.join(dir, 'trace-old.zip');
    const fresh = path.join(dir, 'trace-new.zip');
    fs.writeFileSync(old, 'aaa');
    const pastSec = (Date.now() - 60_000) / 1000;
    fs.utimesSync(old, pastSec, pastSec);
    fs.writeFileSync(fresh, 'bbbb');

    const resp = await req('GET', '/sessions/list-user/traces');
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.traces.length).toBe(2);
    expect(data.traces[0].filename).toBe('trace-new.zip');
    expect(data.traces[1].filename).toBe('trace-old.zip');
    expect(data.traces[0].sizeBytes).toBe(4);
    expect(data.traces[1].sizeBytes).toBe(3);
  });

  // ── GET /sessions/:userId/traces/:filename ──

  test('GET /sessions/:userId/traces/:filename streams a zip file', async () => {
    const dir = ensureTracesDir(baseDir, 'dl-user');
    const content = Buffer.from('PK\x03\x04fake-zip-content');
    fs.writeFileSync(path.join(dir, 'test-trace.zip'), content);

    const resp = await fetch(`${baseUrl}/sessions/dl-user/traces/test-trace.zip`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('application/zip');
    expect(resp.headers.get('content-length')).toBe(String(content.length));
    const body = Buffer.from(await resp.arrayBuffer());
    expect(body).toEqual(content);
  });

  test('GET /sessions/:userId/traces/:filename returns 404 for missing file', async () => {
    const resp = await req('GET', '/sessions/dl-user/traces/nonexistent.zip');
    expect(resp.status).toBe(404);
    const data = await resp.json();
    expect(data.error).toBe('not found');
  });

  test('GET /sessions/:userId/traces/:filename returns 400 for path traversal', async () => {
    const resp = await req('GET', '/sessions/dl-user/traces/..%2F..%2Fetc%2Fpasswd');
    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error).toBe('invalid filename');
  });

  // ── DELETE /sessions/:userId/traces/:filename ──

  test('DELETE /sessions/:userId/traces/:filename removes the file', async () => {
    const dir = ensureTracesDir(baseDir, 'del-user');
    const filePath = path.join(dir, 'doomed.zip');
    fs.writeFileSync(filePath, 'bye');

    const resp = await req('DELETE', '/sessions/del-user/traces/doomed.zip');
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);

    // File should be gone
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('DELETE /sessions/:userId/traces/:filename returns 404 for missing file', async () => {
    const resp = await req('DELETE', '/sessions/del-user/traces/ghost.zip');
    expect(resp.status).toBe(404);
    const data = await resp.json();
    expect(data.error).toBe('not found');
  });

  test('DELETE /sessions/:userId/traces/:filename returns 400 for path traversal', async () => {
    const resp = await req('DELETE', '/sessions/del-user/traces/.hidden-file');
    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error).toBe('invalid filename');
  });

  // ── Full lifecycle ──

  test('full lifecycle: create traced session → list → download → delete', async () => {
    const uid = 'lifecycle-user';

    // 1. Create tab with tracing
    const createResp = await req('POST', '/tabs', { userId: uid, sessionKey: 'lc1', trace: true });
    expect(createResp.status).toBe(200);

    // 2. List traces — should have exactly one
    const listResp = await req('GET', `/sessions/${uid}/traces`);
    const { traces } = await listResp.json();
    expect(traces.length).toBe(1);
    const filename = traces[0].filename;
    expect(filename).toMatch(/^trace-.*\.zip$/);

    // 3. Download the trace
    const dlResp = await fetch(`${baseUrl}/sessions/${uid}/traces/${filename}`);
    expect(dlResp.status).toBe(200);
    expect(dlResp.headers.get('content-type')).toBe('application/zip');
    const body = await dlResp.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);

    // 4. Delete the trace
    const delResp = await req('DELETE', `/sessions/${uid}/traces/${filename}`);
    expect(delResp.status).toBe(200);

    // 5. List again — should be empty
    const list2Resp = await req('GET', `/sessions/${uid}/traces`);
    const { traces: remaining } = await list2Resp.json();
    expect(remaining).toEqual([]);
  });

  // ── TOCTOU race: file deleted between stat and stream ──

  test('GET trace download handles file vanishing after stat (TOCTOU)', async () => {
    const dir = ensureTracesDir(baseDir, 'race-user');
    const filePath = path.join(dir, 'vanish.zip');
    fs.writeFileSync(filePath, 'data');

    // stat will succeed, then we delete the file before stream opens
    // We can't perfectly time this, but we CAN delete immediately after stat
    // by hooking into the async flow. Instead, test the stream error path
    // directly: delete the file, then request it — stat returns null → 404.
    // For the true race, we test stream.on('error') by deleting after stat
    // via a parallel request.
    const statPromise = fetch(`${baseUrl}/sessions/race-user/traces/vanish.zip`);
    // Immediately delete to race the stream open
    fs.unlinkSync(filePath);
    const resp = await statPromise;
    // Should get 404 from either stat miss or stream error — not a 500 crash
    expect([200, 404]).toContain(resp.status);
    if (resp.status === 200) {
      // If we raced past stat, the stream error handler should have fired
      // and the response should still complete without crashing the server
      await resp.arrayBuffer();
    }
  });

  // ── Auth rejection ──

  test('trace endpoints reject non-loopback requests when API key is set', async () => {
    // Build a separate app WITH an API key
    const authDir = makeTempBase();
    const authApp = express();
    authApp.use(express.json());
    const authConfig = { apiKey: 'test-secret-key', nodeEnv: 'test' };
    const strictAuth = () => requireAuth(authConfig);

    authApp.get('/sessions/:userId/traces', strictAuth(), async (req, res) => {
      res.json({ traces: [] });
    });

    const authServer = await new Promise((resolve) => {
      const s = authApp.listen(0, () => resolve(s));
    });
    const authUrl = `http://localhost:${authServer.address().port}`;

    try {
      // No auth header → 403
      const r1 = await fetch(`${authUrl}/sessions/user1/traces`);
      expect(r1.status).toBe(403);

      // Wrong key → 403
      const r2 = await fetch(`${authUrl}/sessions/user1/traces`, {
        headers: { Authorization: 'Bearer wrong-key' },
      });
      expect(r2.status).toBe(403);

      // Correct key → 200
      const r3 = await fetch(`${authUrl}/sessions/user1/traces`, {
        headers: { Authorization: 'Bearer test-secret-key' },
      });
      expect(r3.status).toBe(200);
    } finally {
      await new Promise((resolve) => authServer.close(resolve));
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  });
});
