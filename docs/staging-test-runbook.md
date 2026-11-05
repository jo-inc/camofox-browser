# Staging test runbook

Instructions for running live tests against the staging Camofox server on Railway.
Written so Claude can follow it without asking again.

## 1. Setup (once per session)

The user sends staging values. Write them to `.env` in the repo root. Never commit `.env` (it is git-ignored) and never paste the access key into chat, docs, or commit messages.

```
CAMOFOX_BASE_URL=https://<staging-host>.up.railway.app
CAMOFOX_ACCESS_KEY=<staging access key>
```

Rules:
- Use `CAMOFOX_BASE_URL` for the staging host only. If it is missing or not `https`, stop and ask.
- Use only staging values. If the user sends a production URL or key, do not use it. Ask them to confirm it is staging.
- Check the server is up before any test: `curl -s -o /dev/null -w "%{http_code}" "$CAMOFOX_BASE_URL/health"` should return `200`.

## 2. Confirm the branch under test

```
git branch --show-current        # expect feature/handoff-live-control
git log --oneline -1             # note the commit
```

Tell the user which commit will be tested, because Railway may be running an older deploy. If Railway is on an older commit, say so and ask them to redeploy before reading results.

## 3. Run the tests

Run in this order. Stop at the first failure and report it.

1. Existing live-viewer checks (token, frame, auth):
   `node scripts/test-live-viewer.mjs`
2. Handoff flow, end to end:
   `node scripts/test-handoff-live.mjs`
3. Branch feature checks (state, macros, dismiss):
   `node scripts/test-branch-features.mjs`

Each script prints PASS or FAIL per check and exits non-zero on failure.

## 4. Report

Report to the user in this form:
- the commit tested, and the staging host (not the key)
- counts: passed, failed
- every FAIL line, copied exactly
- what you did not test

Do not claim "production grade" from a passing run alone. Only the checks that ran count.

## 5. Clean up

The scripts close their own tabs and sessions. If a run stops early, check the handoff is released:
`POST /tabs/{tabId}/handoff/release` with the test `userId`. Do not leave a handoff active on staging.

## Limits to remember

- Handoff state is in-process. A staging server with more than one instance can give false failures.
- The two-user test is not in these scripts yet. Do not report multi-user isolation as tested.
- Typed text (including test passwords) is sent but never printed by the scripts. Do not add logging of it.
