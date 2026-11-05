# Eve tool: camofox_handoff

Lets an agent pause on a browser tab so the user can act on it (sign in, enter a code, solve a check), then resume.

**Install:** copy `camofox_handoff.ts` to `agent/tools/` in your Eve agent. It needs `agent/lib/camofox.ts` (the shared Camofox helpers) and nothing else from this repo.

## Actions

| action | what it does | returns |
|---|---|---|
| `start` | Pauses agent actions on the tab and issues a control link | `controlUrl` to send to the user |
| `status` | Reads whether a person holds the tab | `mode`, `until`, `reason` |
| `release` | Returns the tab to the agent | `mode: agent` |

Inputs: `tabId`, `action`, `reason` (required for `start`, max 200 characters), `idleMinutes` (1–30, default 10).

## Behaviour

- While a handoff is active, agent actions on that tab get 409 `human_in_control`. The agent should wait, not retry.
- The user acts in the live view and presses **Done** to return control. Control also ends after `idleMinutes` with no input.
- If the control link cannot be issued, `start` releases the handoff so the agent is not left blocked.
- The control link is accepted only over `https` (local `http` is allowed outside production).
- The control link is a credential for one user and one tab. Send it only to the user who owns the session.

## Server routes used

- `POST /tabs/{tabId}/handoff`
- `POST /tabs/{tabId}/handoff/release`
- `GET /tabs/{tabId}/control`
- `POST /live-viewer/links` with `control: true`

## Known limits

- Handoff state lives in one server process. Multiple server instances need shared state first.
- Tested against a mock server only (9 checks). Run `scripts/test-handoff-live.mjs` against a live server before relying on it.
