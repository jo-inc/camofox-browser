# evaluate-jobs

Runs a long `evaluate` as a job. `POST /tabs/:tabId/evaluate` holds one HTTP request open for the whole script, and clients and proxies often drop a response that takes minutes (Node's `fetch` gives up at 300 s), losing the result. Here the script starts at once and its result is read back later, with short long-polls.

Disabled by default. Enable with `ENABLE_EVALUATE_JOBS=1`, or in `camofox.config.json`:

```json
{ "plugins": { "evaluate-jobs": { "enabled": true, "maxRunningPerUser": 10 } } }
```

## Start a job

`POST /tabs/:tabId/evaluate-async` (auth required)

| Field | Type | Notes |
|-------|------|-------|
| `userId` | string | required; the tab's owner |
| `expression` | string | required; evaluated in the page as `POST /tabs/:tabId/evaluate` does |
| `timeoutMs` | integer | 1000..900000, default 900000 |

Answers `202 { ok: false, jobId, state: "running", elapsedMs }`. `404` for an unknown tab, `429 too_many_jobs` when the user already has `maxRunningPerUser` jobs running.

## Read a job

`GET /tabs/:tabId/evaluate-async/:jobId?userId=...&waitMs=...` (auth required)

`waitMs` (0..120000, default 0) holds the request until the job settles or the wait ends. The answer is `{ ok, jobId, state, result?, error?, code?, tabKept?, elapsedMs }`, `state` one of:

| state | meaning |
|-------|---------|
| `running` | still running |
| `done` | `ok: true`, `result` holds the value |
| `timeout` | passed `timeoutMs`: `code: "evaluate_timeout"`, `tabKept: true`; the tab stays up and the script may still be running in the page |
| `error` | the script threw or the page went away: `error` holds the message |

`404 job_not_found` for a job of another tab or user, or one that finished more than 15 minutes ago.

## Notes

- Jobs are in memory only: a server restart loses them, as it loses the tabs they ran in.
- A running job keeps its tab from the idle reapers until its deadline, as a core evaluate does.
- The routes are the plugin's own, so they are not in `openapi.json` and have no MCP tool.
