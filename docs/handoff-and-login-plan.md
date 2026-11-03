# Agent handoff and user login plan

Status: **planning.** Nothing in this document is built yet, except the items marked as existing.

This plan covers two connected features:

1. **Handoff.** A user can watch the agent's browser live, take control when needed, and hand control back.
2. **Login vault.** Users save their site logins once. The agent asks the server to log in for a site, and the server fills in the password. The agent never sees the password.

---

## 1. What exists today

| Piece | State | Notes |
|---|---|---|
| Camofox browser server (Railway) | Running | Access key required on all routes except `/health` |
| Live viewer (`plugins/live-viewer`) | Running, view-only | Signed per-tab links, screenshots about once a second, action log |
| Click/type action log in viewer | Reverted | Removed at your request; can be re-added later |
| VNC shared display | Running on Railway but **not for users** | One shared screen, so it cannot give per-user views |
| Eve tools (`camofox_*`) | Running | Click, type, scroll, navigate, snapshot, close, cookies |
| Eve live-viewer link TTL | 120 seconds | Set in the Eve app; server default is 30 min, max 4 hours |
| Persistence plugin | Running | Saves per-user session state. **Stored in plain JSON, which must be fixed (Phase 6)** |
| Proxy | Not configured | Needed if Google and other sites block Railway's IP |
| Handoff / takeover | Not built | This plan |
| Login vault | Not built | This plan |

---

## 2. Decisions needed before building

These must be settled first. Phase 0 is a decision checkpoint, not code.

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Which 1Password product? | (a) Service account + SDK, (b) Connect server (self-hosted) | (a) is simpler to run. Check that your plan includes service accounts (I believe it needs a Business plan, but confirm current terms). |
| D2 | Vault layout | (a) One vault for all users, items tagged per user, (b) one vault per user | (a) is easier to manage. Tag items with the same hashed user ID that `getCamofoxUserId` already produces. |
| D3 | First sites to support | e.g. one shopping site, one ride app, one food app | Start with 1–2 sites where we can test with a dummy account. |
| D4 | Two-factor codes (SMS, app, email) | (a) Hand off to the user in the live viewer, (b) skip those sites | (a). The agent cannot read codes safely. |
| D5 | Can users watch logins live? | Yes / no | Yes, but the login step hides screenshots (see Security rules). |
| D6 | Who may take over a tab? | Only the tab owner | Only the tab owner. Enforced by the signed link. |

---

## 3. Architecture

### 3.1 Handoff (control flag)

```
Agent (Eve tool)                 Camofox server                    User (viewer)
     |                                |                                 |
     | click/type/navigate ---------> | check tab control flag          |
     |                                |  if human -> 409 human_in_control|
     |                                |  if agent -> perform action     |
     |                                |                                 |
     |                                | <--- POST /live-viewer/input ---| (takeover on)
     |                                |  perform human action           |
     |                                |                                 |
     |                                | <--- hand back ----------------- |
```

- **Control flag** lives in `lib/tab-control.js` (new). It is a core module, not a plugin, so the action routes in `server.js` can check it without depending on a plugin.
- States per tab: `agent` (default) or `human`.
- Human control expires after a period of inactivity (default 5 minutes), returning the tab to the agent.
- Agent action routes return `409 { error: "human_in_control" }` while a human holds the tab. The Eve tool reports this to the agent, which must stop and tell the user.

### 3.2 Login vault (1Password)

```
User browser (Vercel app)
   | 1. enters email + password in a small form (HTTPS)
   v
Vercel API route (server-side only)
   | 2. writes item to 1Password with service account token
   v
1Password vault "Camofox Users"
   item tag = hashed userId, fields: username, password, website URL

Agent (Eve tool: camofox_login { tabId, site })
   | 3. asks Camofox to log in for a site. Sends NO credentials.
   v
Camofox server  POST /tabs/:tabId/login
   | 4. reads the user's item from 1Password (server-side token)
   | 5. checks the current page domain matches the item's website URL
   | 6. fills the login form with a per-site recipe
   | 7. submits, checks result
   v
Returns { status: "logged_in" | "failed" | "needs_human" }
```

Key points:

- **The agent sees only the site name and the status.** The password never enters the agent's context, tool results, or logs.
- **The browser (user side) never talks to 1Password directly.** Only the Vercel server and the Camofox server hold the 1Password token.
- **Per-site recipes** tell the server which fields to fill and which buttons to press for each site. They are code in the repo, reviewed like any other change.
- **After a successful login**, the persistence plugin saves the session so later runs do not need to log in again.

---

## 4. Security rules (non-negotiable)

These rules apply to every phase. Any change that breaks one needs explicit sign-off.

1. **Credentials never reach the agent.** Not in tool inputs, tool outputs, snapshots, logs, traces, or error messages.
2. **Domain binding.** The server fills a credential only when the page's domain matches the website URL stored with that item. This stops a manipulated agent from sending a user's password to another site.
3. **No credentials in our database.** The Vercel app writes straight to 1Password and does not store passwords in its own database.
4. **Secrets only in environment variables.** The 1Password token lives in Vercel and Railway secret settings, never in the repo.
5. **Log hygiene.** Request bodies for `/login` and the Vercel credential form are never logged. A test greps logs for a known test password.
6. **Frames hidden during login.** While a login is in progress, `/live-viewer/frame` returns `423 login_in_progress` so the login page is not streamed.
7. **Takeover only for the owner.** Viewer links that allow input are issued only after the app confirms the user owns the tab.
8. **Typed text is never recorded.** Only its length is kept, as now.
9. **Stored sessions are encrypted.** The persistence plugin encrypts saved cookies at rest (Phase 6). Until then, the profile directory must be treated as sensitive.
10. **Audit trail.** Each login attempt and takeover is logged with user hash, site, time, and result, but never credentials.
11. **Review before launch.** A security review by someone with experience in credential handling is required before real users' passwords are stored.
12. **Terms of service.** Each site is checked for rules against automated login before we add it.

---

## 5. Build phases

Each phase has a done-when list. We do not start a phase until the previous one passes its tests.

### Phase 0: Decisions
- [ ] Settle D1–D6 in section 2
- [ ] Confirm 1Password plan includes service accounts (or Connect)
- [ ] Pick the first two sites for login support
- [ ] Create the 1Password account and the "Camofox Users" vault
- **Done when:** decisions are written into this file.

### Phase 1: Control flag (no behaviour change)
- [ ] Add `lib/tab-control.js` with `getControl`, `setHuman`, `setAgent`, auto-expiry
- [ ] Add check to click, type, scroll, navigate, back, forward, refresh routes in `server.js`
- [ ] With the flag set to `agent`, behaviour is identical to today
- [ ] Add unit tests for the flag and for each gated route
- [ ] Update OpenAPI spec for the new `409` response
- **Done when:** all existing tests pass, and gated routes return `409` only while the flag is `human`.

### Phase 2: Viewer input and takeover UI
- [ ] Add `POST /live-viewer/input` in `plugins/live-viewer/index.js`, authorised by a signed token with a `control` claim
- [ ] Input types: click (coordinates scaled to viewport), type, key press, scroll
- [ ] Rate-limit input per tab
- [ ] Viewer page: "Take over" and "Hand back" buttons, and a control status line
- [ ] Viewer shows who is in control
- [ ] Extend `scripts/test-live-viewer.mjs` with takeover tests
- **Done when:** a human can take over, click, type, scroll, and hand back, and the agent is blocked only during takeover.

### Phase 3: Agent handoff request
- [ ] Add Eve tool `camofox_request_handoff { tabId, reason }` that sets the tab to human control and returns the viewer link
- [ ] Eve tools report `human_in_control` to the agent with instructions to stop
- [ ] Auto-release tested
- **Done when:** the agent can hand control to the user and resume after hand-back, with no stuck tabs.

### Phase 4: Credential vault and login route
- [ ] Vercel: form for email and password, posting to a server route that writes to 1Password
- [ ] Vercel: server route for listing a user's saved sites (no passwords returned)
- [ ] Camofox: `POST /tabs/:tabId/login { userId, site }` reads the item by user tag
- [ ] Domain binding check before filling
- [ ] Wrong password, missing item, and domain mismatch each return a clear status
- [ ] Eve tool `camofox_login { tabId, site }` takes only the site name
- [ ] Test fixture: a local login page in the repo, used with a dummy account
- [ ] Log-hygiene test: grep logs for the test password
- **Done when:** a fixture site logs in through the vault, the agent never sees the password, and a mismatched domain is refused.

### Phase 5: Site recipes and two-factor handoff
- [ ] Recipe for each site from D3, with a test account
- [ ] Detect two-factor, CAPTCHA, or "new device" pages and return `needs_human`
- [ ] On `needs_human`, the agent calls handoff (Phase 3)
- **Done when:** each chosen site logs in with a test account, and a two-factor prompt hands off to the user.

### Phase 6: Encrypted sessions and audit log
- [ ] Encrypt persisted session state at rest
- [ ] Audit log entries for login attempts and takeovers, with no credentials
- [ ] Document key rotation
- **Done when:** saved profile files are unreadable without the key, and the audit log shows events without secrets.

### Phase 7: Review and launch
- [ ] Security review (rule 11)
- [ ] Load test: several viewers open at once, watching Railway memory and CPU
- [ ] Terms-of-service check for each live site (rule 12)
- [ ] Runbook: how to revoke a user's vault items, end a takeover, and rotate tokens
- **Done when:** review findings are closed and the runbook is written.

---

## 6. Test plan summary

| Test | Phase | Pass condition |
|---|---|---|
| Control flag unit tests | 1 | Flag transitions and auto-expiry behave correctly |
| Gated routes with flag off | 1 | Identical responses to today |
| Gated routes with flag on | 1 | `409 human_in_control` |
| Viewer input | 2 | Clicks land at the right position |
| Hand-back | 2–3 | Agent resumes; no stuck tabs |
| Login on fixture page | 4 | Logged in; password absent from all outputs |
| Domain mismatch | 4 | Refused with a clear status |
| Log hygiene | 4 | Test password not found in logs |
| Two-factor detection | 5 | `needs_human` returned and handoff works |
| Encrypted profile | 6 | Files unreadable without key |

---

## 7. Known limits

- **Viewer lag.** The viewer refreshes about once a second, so takeover will feel slow. A faster stream is a later project.
- **Two-factor codes** are handled by the user, never the agent.
- **CAPTCHAs** are handed to the user, not solved.
- **Sites change.** Recipes break when a site redesigns its login page. Each recipe needs a weekly test.
- **IP blocks.** Some sites block Railway's datacenter IP. A residential proxy may be needed (see the proxy notes in the README).
- **Terms.** Some sites forbid automated logins. Those are excluded.

---

## 8. Open items

- [ ] D1–D6 decisions (Phase 0)
- [ ] 1Password plan check
- [ ] First two sites
- [ ] Residential proxy decision, if Google or the target sites keep blocking Railway
- [ ] Who performs the security review
