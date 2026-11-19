# Evaluate Jobs Plugin — Agent Guide

Runs a long `evaluate` as a job whose result is read back later, so a script that outlives a client's HTTP timeout still returns its result.

## Endpoints

- `POST /tabs/:tabId/evaluate-async` — start a job, 202 `{ jobId, state: "running" }` (requires auth)
- `GET /tabs/:tabId/evaluate-async/:jobId?userId=...&waitMs=...` — read a job, long-polling up to `waitMs` (requires auth)

## Activation

Disabled by default. Enable with `ENABLE_EVALUATE_JOBS=1` env var or `"evaluate-jobs": { "enabled": true }` in `camofox.config.json`.

## Key Files

- `index.js` — route handlers only (no `child_process`, no `process.env` reads)
- `jobs.js` — the in-memory job store, input validation and the response shape
- `jobs.test.js`, `plugin.test.js` — unit and route tests

## Events

| Event | Payload |
|-------|---------|
| `tab:evaluate` | `{ userId, tabId, expression }` when a job starts |
| `tab:evaluated` | `{ userId, tabId, result }` when a job finishes with a result |

## Safety

- Jobs are scoped to the tab and normalized userId that started them; anyone else gets 404
- `timeoutMs` and `waitMs` are range-checked and rejected with 400, never clamped
- At most `maxRunningPerUser` (default 10) jobs run per user at once; more are refused with 429
- A finished job is dropped 15 minutes after it finishes; nothing is kept on disk
