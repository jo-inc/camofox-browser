# Security checklist

- **The access key is a full-access key.** Anyone holding it can act on any user's tab if they know the userId and tab ID. Keep it on your backend. Do not give it to third-party apps. If an outside app needs access, put your own backend in front and let it call Camofox for its own users only.
- **userId is not a secret.** It only selects the tab. The key is the real gate.
- **Set userId from your authenticated session.** Never from user input, never from a model's output.
- **Viewer links are credentials.** One tab, limited time. Never put them in logs, analytics, or shared channels. Send to the owner only.
- **Typed text is never logged.** Only its length is logged. Keep it that way in any wrapper you write.
- **No VNC.** Do not expose VNC. Use the live viewer.
- **No plain-text session storage.** Saved sessions are encrypted with `CAMOFOX_STORAGE_KEY`. If that key is lost, saved sessions cannot be read; that is by design.
- **Rotate the access key** if it appears in a chat, a log, a screenshot or a commit. Update Railway and every client together.
- **Respect sites.** Do not bypass robots.txt, terms of use, or captchas. Hand off to a person instead.
