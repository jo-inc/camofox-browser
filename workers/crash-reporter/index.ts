/**
 * Cloudflare Worker relay for camofox-browser crash reports.
 *
 * Accepts anonymized crash/hang/stall reports from clients and files them as
 * GitHub Issues using a GitHub App. The private key lives here as an env secret
 * -- never shipped in the npm package.
 *
 * Routes:
 *   POST /report  -- file or deduplicate a crash report
 *   GET  /source  -- returns { commit, sha256 } for verification
 *   GET  /health  -- health check
 *
 * Env secrets (set via `wrangler secret put`):
 *   GH_APP_ID, GH_INSTALL_ID, GH_PRIVATE_KEY
 *
 * Source: https://github.com/jo-inc/camofox-browser/blob/main/workers/crash-reporter/index.ts
 */

interface Env {
  GH_APP_ID: string;
  GH_INSTALL_ID: string;
  GH_PRIVATE_KEY: string;
  GH_REPO?: string; // default: jo-inc/camofox-browser
}

// --- Rate limiting (in-memory, per-isolate) ---
const ipBuckets = new Map<string, number[]>();
const MAX_PER_IP_PER_HOUR = 30;

function rateLimit(ip: string): boolean {
  const now = Date.now();
  let timestamps = ipBuckets.get(ip) || [];
  timestamps = timestamps.filter((t) => t > now - 3_600_000);
  if (timestamps.length >= MAX_PER_IP_PER_HOUR) return false;
  timestamps.push(now);
  ipBuckets.set(ip, timestamps);
  return true;
}

// --- Dedup (in-memory, 1-hour window) ---
const recentSignatures = new Map<string, number>();

function isDuplicate(signature: string): boolean {
  const now = Date.now();
  // Sweep old entries
  for (const [sig, ts] of recentSignatures) {
    if (ts < now - 3_600_000) recentSignatures.delete(sig);
  }
  if (recentSignatures.has(signature)) return true;
  recentSignatures.set(signature, now);
  return false;
}

// --- GitHub App JWT ---
async function signJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payload = btoa(JSON.stringify({ iss: appId, iat: now - 60, exp: now + 600 }))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = `${header}.${payload}`;

  // GH_PRIVATE_KEY is raw base64-encoded PKCS#8 DER (no PEM headers).
  // To generate: openssl pkcs8 -topk8 -inform PEM -outform DER -nocrypt -in key.pem | base64
  const binaryKey = Uint8Array.from(atob(privateKeyPem.replace(/\s/g, "")), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  const b64sig = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return `${unsigned}.${b64sig}`;
}

async function getInstallationToken(env: Env): Promise<string | null> {
  const jwt = await signJwt(env.GH_APP_ID, env.GH_PRIVATE_KEY);
  const resp = await fetch(
    `https://api.github.com/app/installations/${env.GH_INSTALL_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "camofox-telemetry",
      },
    },
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as { token: string };
  return data.token;
}

// --- Payload validation ---
const VALID_TYPES = new Set([
  "crash", "hang", "stuck", "stuck:event-loop", "stuck:tab-lock",
  "leak:native-memory", "signal:SIGTERM", "signal:SIGSEGV", "signal:SIGABRT",
]);

function isValidType(type: string): boolean {
  if (VALID_TYPES.has(type)) return true;
  // Allow hang:*, signal:*, stuck:*, leak:*
  return /^(hang|signal|stuck|leak|crash):[\w\-.:]+$/.test(type);
}

interface CrashReport {
  type: string;
  signature: string;
  title: string;
  body: string;
  labels: string[];
  version?: string;
}

const MIN_VERSION = "1.8.10";

function isVersionAllowed(version?: string): boolean {
  if (!version) return false;
  const parts = version.split(".").map(Number);
  const min = MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] || 0) > (min[i] || 0)) return true;
    if ((parts[i] || 0) < (min[i] || 0)) return false;
  }
  return true; // equal
}

function validatePayload(data: unknown): CrashReport | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.type !== "string" || !isValidType(d.type)) return null;
  if (typeof d.signature !== "string" || !/^[0-9a-f]{8}$/.test(d.signature)) return null;
  if (typeof d.title !== "string" || d.title.length === 0 || d.title.length > 256) return null;
  if (typeof d.body !== "string" || d.body.length > 65536) return null;
  if (!Array.isArray(d.labels) || d.labels.some((l) => typeof l !== "string")) return null;
  const version = typeof d.version === "string" ? d.version : undefined;
  if (!isVersionAllowed(version)) return null;
  return {
    type: d.type,
    signature: d.signature,
    title: d.title,
    body: d.body,
    labels: (d.labels as string[]).slice(0, 5),
    version,
  };
}

// --- Issue creation ---
async function findExistingIssue(token: string, repo: string, signature: string): Promise<number | null> {
  const q = encodeURIComponent(`repo:${repo} is:issue is:open "[${signature}]" in:title`);
  const resp = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=1`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "camofox-telemetry",
    },
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { items?: { number: number }[] };
  return data.items?.[0]?.number ?? null;
}

async function commentOnIssue(token: string, repo: string, issueNumber: number, body: string): Promise<boolean> {
  const resp = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "camofox-telemetry",
    },
    body: JSON.stringify({ body: body.slice(0, 4096) }),
  });
  return resp.ok;
}

async function createIssue(
  token: string, repo: string, title: string, body: string, labels: string[],
): Promise<string | null> {
  const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "camofox-telemetry",
    },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { html_url?: string };
  return data.html_url ?? null;
}

// --- Source verification ---
// These are replaced at deploy time by the CI workflow
const COMMIT_SHA = "__COMMIT_SHA__";
const SOURCE_SHA256 = "__SOURCE_SHA256__";

// --- Request handler ---
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // GET /health
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok" }, { headers: cors });
    }

    // GET /source
    if (url.pathname === "/source" && request.method === "GET") {
      return Response.json({
        commit: COMMIT_SHA,
        sha256: SOURCE_SHA256,
        source: "https://github.com/jo-inc/camofox-browser/blob/main/workers/crash-reporter/index.ts",
      }, { headers: cors });
    }

    // POST /report
    if (url.pathname === "/report" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!rateLimit(ip)) {
        return Response.json({ error: "rate limited" }, { status: 429, headers: cors });
      }

      let payload: CrashReport | null;
      try {
        payload = validatePayload(await request.json());
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400, headers: cors });
      }
      if (!payload) {
        return Response.json({ error: "invalid payload" }, { status: 400, headers: cors });
      }

      // Dedup: same signature within 1 hour -> skip (client already deduped, this is a safety net)
      if (isDuplicate(payload.signature)) {
        return Response.json({ status: "deduped" }, { headers: cors });
      }

      try {
        // Get GitHub installation token
        const token = await getInstallationToken(env);
        if (!token) {
          return Response.json({ error: "github auth failed" }, { status: 502, headers: cors });
        }

        const repo = env.GH_REPO || "jo-inc/camofox-browser";

        // Check for existing issue with same signature
        const existing = await findExistingIssue(token, repo, payload.signature);
        if (existing) {
          const comment = [
            `**+1** -- ${new Date().toISOString()}`,
            payload.version ? `Version: ${payload.version}` : null,
          ].filter(Boolean).join("\n");
          await commentOnIssue(token, repo, existing, comment);
          return Response.json({ status: "commented", issue: existing }, { headers: cors });
        }

        // Create new issue
        const issueUrl = await createIssue(token, repo, payload.title, payload.body, payload.labels);
        if (!issueUrl) {
          return Response.json({ error: "issue creation failed" }, { status: 502, headers: cors });
        }

        return Response.json({ status: "created", url: issueUrl }, { headers: cors });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: "internal", detail: msg }, { status: 500, headers: cors });
      }
    }

    return Response.json({ error: "not found" }, { status: 404, headers: cors });
  },
};
