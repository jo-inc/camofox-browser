# Deploying Camofox on Railway

This is the path the team uses. Any Docker host works the same way: build the repo's `Dockerfile`, expose port 9377 (or set `PORT`), and set the variables below.

## 1. Create the service

1. In Railway, create a project and add a service from the GitHub repo (the branch with the live viewer and handoff, currently `feature/handoff-live-control` until it is merged).
2. Railway builds the `Dockerfile`. The container runs `node server.js`.
3. Under **Settings > Networking**, generate a public domain. This is the **base URL**.

## 2. Environment variables

Set these in the service's **Variables** tab.

| Variable | Required | How to get it |
|---|---|---|
| `CAMOFOX_ACCESS_KEY` | **yes** | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Every client sends this as `Bearer` |
| `CAMOFOX_STORAGE_KEY` | for saved logins | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Without it, nothing is saved between sessions |
| `CAMOFOX_PROFILE_DIR` | for saved logins | A path on a Railway **volume**, for example `/data/profiles`. Without a volume, saved sessions are lost on redeploy |
| `PROXY_*` | only if needed | Set only after the stealth benchmark shows a datacenter IP is the reason a site fails. See `PROXY_STRATEGY`, `PROXY_HOST`, `PROXY_PORT`, `PROXY_USERNAME`, `PROXY_PASSWORD` in `lib/config.js` |

Do **not** set `ENABLE_VNC`, `VNC_PASSWORD`, `VNC_BIND` or `NOVNC_PORT`. The live viewer replaces VNC, and a public VNC port with a shared password is a risk.

## 3. Attach a volume (for saved logins)

1. In the service, **Settings > Volumes**, add a volume mounted at `/data`.
2. Set `CAMOFOX_PROFILE_DIR=/data/profiles`.
3. Redeploy.

## 4. Check it

From any machine with the repo:

```
node scripts/setup-env.mjs --base-url https://<your-domain>     # writes .env (git-ignored, chmod 600)
node scripts/check-server.mjs                                   # must print all PASS
```

`setup-env.mjs` asks for the access key if it is not in the environment, and never prints it back.

## 5. Common problems

- **401 on every call:** the key in `.env` or the client does not match `CAMOFOX_ACCESS_KEY` on Railway.
- **Health works, tab creation fails with `NS_ERROR_NET_RESET`:** the target site is refusing the server's IP. Try a site that does not block datacenter IPs first. Only then consider a proxy (see the stealth benchmark).
- **Saved logins disappear after a redeploy:** the volume is not mounted, or `CAMOFOX_PROFILE_DIR` points outside it.
- **Banner "This workspace needs attention":** check Railway's usage and billing page. A paused project stops serving requests.
