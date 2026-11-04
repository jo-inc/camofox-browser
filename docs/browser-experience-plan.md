# Browser experience plan: pop-ups, page state, stealth, macros

Status: **in progress** on branch `feature/browser-experience`. Additive only. No existing route, tool or behaviour is changed.

This is a separate plan from `docs/handoff-and-login-plan.md`. That plan covers takeover and login. This one covers what the agent sees and does on a page.

---

## 1. Goals

1. **Overlay handling.** The agent can close pop-ups, modals and banners without clicking anything that accepts terms, signs in, buys or submits.
2. **Page-state awareness.** The agent can tell a captcha, a block page, a sign-in wall, a verification-code prompt, a consent banner, an empty result set and a normal page apart.
3. **Stealth.** Measured, not assumed. A benchmark runs against the live Railway server before any change, and again after. A residential proxy is decided from the results.
4. **Macros across categories and regions.** Search macros for shopping, jobs, housing, health and research, plus UK and other top-country sites. Every URL format is checked against a real results page before it is added.
5. **Safety of the additions.** Existing macros, routes and tests keep working. New tests cover each new behaviour.

## 2. Scope of this change set

| Item | Status | Where |
|---|---|---|
| Page-state classifier (pure) | Done | `lib/page-state.js` |
| Overlay target selection (pure) | Done | `lib/overlays.js` |
| `GET /tabs/:tabId/state` | Done | `server.js` |
| `POST /tabs/:tabId/overlays/dismiss` | Done | `server.js` |
| OpenAPI spec regenerated (40 paths) | Done | `openapi.json` |
| Unit tests for both modules | Done | `tests/unit/pageState.test.js`, `tests/unit/overlays.test.js` |
| Four new verified macros | Done | `lib/macros.js`, `mcp/lib/tool-contracts.mjs`, `tests/unit/macros.test.js` |
| Stealth benchmark script | **Not started** (see section 5) | planned: `scripts/test-stealth-bench.mjs` |
| UK and other-country macros | **Not added** (see section 4) | pending verification |
| Eve tool wrappers for the two routes | **Not started** | Eve project, user-owned |
| Residential proxy | **Not decided** | after benchmark |

## 3. Design

### 3.1 Page state (`lib/page-state.js`)

A pure function, `classifyPageState({ url, title, text })`, returns `{ kind, reasons }`.

Rules run in priority order, and the first match wins:

1. `captcha`: challenge wording such as "verify you are human" or "press and hold".
2. `block`: "access denied", "request blocked", "error 1020".
3. `two_factor`: verification-code prompts.
4. `login_wall`: a login path in the URL, or "sign in to continue".
5. `consent`: a cookie or privacy banner that has both a settings phrase and an accept or reject control.
6. `no_results`: explicit empty-result phrases.
7. `ok`: nothing matched.

Every rule is a specific phrase, so an article that mentions cookies or logins stays `ok`. Only the first 20,000 characters of page text are scanned.

### 3.2 Overlay dismissal (`lib/overlays.js`)

- Only `button` elements are considered.
- The accessible name must match the allow-list **exactly** after normalisation: `Close`, `Dismiss`, `No thanks`, `Not now`, `Maybe later`, `Skip`, `×`, `✕`, and similar.
- A deny pattern (accept, allow, agree, sign in, buy, checkout, pay, subscribe, submit, continue, confirm, download, and others) rejects a name even if it somehow matched the allow-list. This is defence in depth.
- At most `maxClicks` targets are clicked (default 3, capped at 5).
- Each click has a 2-second timeout. Failures are reported, not thrown, so one bad target does not stop the rest.

### 3.3 Routes

- `GET /tabs/:tabId/state?userId=` reads the title and visible text, classifies the page, and lists overlay refs from the last snapshot. It does not refresh refs, so it is cheap to call.
- `POST /tabs/:tabId/overlays/dismiss` refreshes refs, selects targets, clicks them, and returns `{ dismissed, failed }`. It runs under the existing per-user limit and a 30-second timeout.

Both routes use the same tab lookup, `lastAccess` update and error handling as the other tab routes.

## 4. Macros

### 4.1 Added (verified)

| Macro | URL format | Evidence |
|---|---|---|
| `@bestbuy_search` | `bestbuy.com/site/searchpage.jsp?st=` | Search results page returned |
| `@indeed_search` | `indeed.com/jobs?q=` | Job results page returned |
| `@pubmed_search` | `pubmed.ncbi.nlm.nih.gov/?term=` | Results page returned |
| `@zillow_search` | `zillow.com/homes/for_sale/City,-ST_rb/` | Austin, TX page returned 5,452 listings |

The exact query formats above come from the search pages. They are not yet confirmed through the live server. The smoke test in section 6 does that.

### 4.2 Not added, and why

| Site | Result | Reason |
|---|---|---|
| Airbnb, IMDb, Amazon UK, Skyscanner, Google News | Blocked by robots.txt | Not added. Adding them is a policy decision (see section 7) |
| Walmart, Etsy, Target, GitHub search, arXiv, OpenStreetMap | Blocked or refused | Could not verify |
| Booking.com | Returned an empty page | Could not verify |
| Rightmove | Needs a numeric region ID | No plain-text search format |
| Zoopla | Unverified | No confirmed format |
| eBay UK | Returned the category directory | Not a results page |
| Argos | Title "Results for laptop stand", but content was cut off | Not confirmed |
| Google Flights | "Browser unsupported" block | Needs a browser check on the live server |
| Kayak route | Results page seen earlier | Exact format not re-confirmed, so not added |

### 4.3 UK and other top-country macros

Several UK search pages could not be confirmed from this environment. Those that were confirmed are not UK-specific. The UK and country macros need a browser run on the live server, where each URL can be seen rendering. They are queued for the next round, not guessed now.

## 5. Stealth benchmark

Status: **not started**. Benchmark pages have not been chosen. You said "not yet, but make this powerful enough", so the benchmark is planned, not built.

Planned approach:

1. Pick detection pages (for example, a fingerprint test page and a bot-detection test page). You approve the list.
2. `scripts/test-stealth-bench.mjs` opens each page through the live server, reads the verdict, and writes a table.
3. Run it before any stealth change (baseline) and after.
4. Decide the residential proxy from the table: the proxy is added only if the datacenter IP is the reason a site fails.

## 6. Verification

- **Unit tests.** `tests/unit/pageState.test.js`, `tests/unit/overlays.test.js`, `tests/unit/macros.test.js` (count now 18).
- **Regression.** Full unit suite: the same 7 failing suites and 33 failing tests as the environment baseline (no Camoufox binary, add-on download blocked). Nothing new fails. Passing tests rose from 850 to 877.
- **OpenAPI.** Regenerated with `npm run generate-openapi`, 40 paths.
- **Live check, to run on Railway:**
  - `node scripts/test-camofox.mjs --macros @bestbuy_search,@indeed_search,@pubmed_search,@zillow_search`
  - `GET /tabs/:tabId/state` on a page with a cookie banner returns `consent`.
  - `POST /tabs/:tabId/overlays/dismiss` closes a pop-up and leaves an "Accept all" button alone.

## 7. Decisions needed from you

| # | Question | Recommendation |
|---|---|---|
| P1 | Benchmark pages for the stealth test | Choose two or three fingerprint and bot-detection pages |
| P2 | Sites that block robots.txt (Airbnb, IMDb, Amazon UK, Skyscanner, Google News) | Leave them out until you confirm the terms for automated access |
| P3 | Residential proxy | Decide after the benchmark |
| P4 | Eve tool wrappers for the two new routes | Confirm the helper names in `agent/lib/camofox.ts` and I will write them |

## 8. Known limits

- The page-state rules are phrase-based. A new site wording can be missed. Adding a phrase is a small, tested change.
- Overlay dismissal uses exact close labels. A close control with a custom label (an icon with no name, for example) is not clicked. That is deliberate.
- Overlay refs come from the last snapshot. `/state` does not refresh them, so call `/snapshot` first if the page has changed.
