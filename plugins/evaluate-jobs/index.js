/**
 * Evaluate jobs plugin.
 *
 * Runs a long evaluate as a job, so a script that outlives a client's or proxy's HTTP timeout
 * still returns its result: start it, then read it back, optionally long-polling.
 *
 * Disabled by default. Enable with ENABLE_EVALUATE_JOBS=1 or
 * { "evaluate-jobs": { "enabled": true } } in camofox.config.json.
 *
 * Registers:
 *   POST /tabs/:tabId/evaluate-async        -- start a job, 202 { jobId, state: 'running' }
 *   GET  /tabs/:tabId/evaluate-async/:jobId -- read a job (?userId=...&waitMs=...)
 */

import express from 'express';
import { createJobStore, jobView, parseStartParams, parseWaitMs, MAX_RUNNING_PER_USER } from './jobs.js';

export function register(app, ctx) {
  const { log, events, sessions, findTab, normalizeUserId, safeError, config } = ctx;
  const settings = ctx.plugin?.settings ?? {};
  const store = createJobStore({ maxRunningPerUser: settings.maxRunningPerUser ?? MAX_RUNNING_PER_USER });

  app.post('/tabs/:tabId/evaluate-async', ctx.auth(), express.json({ limit: config?.evaluateMaxBodySize ?? '1mb' }), (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const parsed = parseStartParams(req.body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: parsed.code });
      const { expression, timeoutMs } = parsed.params;

      const owner = normalizeUserId(userId);
      const session = sessions.get(owner);
      const found = session && findTab(session, req.params.tabId);
      if (!found) return res.status(404).json({ error: 'Tab not found' });
      session.lastAccess = Date.now();

      const { tabState } = found;
      tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;

      // The idle reapers spare a tab whose evaluating set holds a live deadline, as for core evaluate.
      const run = () => {
        const running = { until: Date.now() + timeoutMs };
        (tabState.evaluating ??= new Set()).add(running);
        return tabState.page.evaluate(expression).finally(() => tabState.evaluating.delete(running));
      };
      const started = store.start({ userId: owner, tabId: req.params.tabId, timeoutMs, run });
      if (!started) {
        return res.status(429).json({ error: 'Too many running evaluate jobs for this user', code: 'too_many_jobs' });
      }
      const { jobId, job } = started;
      events.emit('tab:evaluate', { userId, tabId: req.params.tabId, expression });
      job.settled.then(() => {
        if (job.state === 'done') events.emit('tab:evaluated', { userId, tabId: req.params.tabId, result: job.result });
        log('info', 'evaluate job finished', { tabId: req.params.tabId, userId, jobId, state: job.state });
      });
      log('info', 'evaluate job started', { reqId: req.reqId, tabId: req.params.tabId, userId, jobId, timeoutMs });
      res.status(202).json(jobView(jobId, job));
    } catch (err) {
      log('error', 'evaluate job start failed', { reqId: req.reqId, error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  app.get('/tabs/:tabId/evaluate-async/:jobId', ctx.auth(), async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const wait = parseWaitMs(req.query.waitMs);
      if (!wait.ok) return res.status(400).json({ error: wait.error, code: wait.code });

      const job = store.get(req.params.jobId, { userId: normalizeUserId(userId), tabId: req.params.tabId });
      if (!job) return res.status(404).json({ error: 'Evaluate job not found', code: 'job_not_found' });
      await store.wait(job, wait.waitMs);
      res.json(jobView(req.params.jobId, job));
    } catch (err) {
      log('error', 'evaluate job read failed', { reqId: req.reqId, error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });
}
