# Handoff and saved logins

## Why a handoff

Some pages must not be handled by the agent: a captcha, a sign-in, a one-time code. A handoff pauses the agent on that tab, and the person completes the step in a live view, then returns control.

## The flow

1. `checkpoint(tabId)`: reads the page. For `captcha`, `login_wall` or `two_factor` it starts a handoff with a reason the user sees. For other pages it does nothing.
2. `controlLink(tabId)`: returns a link that can act on the tab. It works only while the handoff is active.
3. Send the link to the user only. Say what to do in one line.
4. The person acts in the live view:
   - clicks and typing go to the page;
   - they can use **Open** to open the same view in a new tab;
   - they press **Done** when finished.
5. The agent gets 409 `human_in_control` while the handoff is active. It must wait.
6. The handoff ends on Done, on `release(tabId)`, or after the idle time (10 minutes by default). The agent then continues.

## Passwords and codes

- The person types passwords and codes in the live view, never in chat.
- The server never logs typed text. Only the length of typed text is logged.
- The agent must not ask for a password, and must not repeat one back.

## Saved logins

- After a handoff ends with Done or release, the server saves the browser session for that userId, encrypted with `CAMOFOX_STORAGE_KEY`.
- The next tab for that userId starts signed in.
- Requires `CAMOFOX_STORAGE_KEY` and a `CAMOFOX_PROFILE_DIR` on a persistent volume.
- A handoff that times out from idleness does not save. Ask the person to press Done.
- To forget a user's saved login: delete `storage-state.enc` in that user's folder under `CAMOFOX_PROFILE_DIR` (the folder is named from the userId), then call `DELETE /sessions/{userId}` to close any open session. There is no API call that deletes the saved file itself.

## Limits

- Handoff state lives in one server process. Two server instances do not share it.
- The viewer link is a credential for one tab for a limited time. Send it only to its user.
