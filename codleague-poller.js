/**
 * CODLeague Live Feed Poller
 * Polls x.com/CODLeague via camofox and serves a live feed at http://localhost:3001
 *
 * Usage:
 *   node codleague-poller.js                        # no auth (may get rate limited)
 *   node codleague-poller.js twitter-cookies.json   # with exported cookies (recommended)
 */

import http from 'http';
import fs from 'fs';
import crypto from 'crypto';

const CAMOFOX = 'http://localhost:9377';
const FEED_PORT = 3001;
const POLL_MS = 60_000;
const USER_ID = 'codleague-user';
const SESSION_KEY = 'codleague-session';
const TARGET = 'https://x.com/CODLeague';

// UI strings to strip from tweet text (exact match)
const UI_NOISE = new Set([
  'Reply', 'Repost', 'Like', 'Bookmark', 'Share', 'More', 'Media',
  'Replies', 'Views', 'Quote', 'Quotes', 'Reposts', 'Likes', 'Follow',
  'Unfollow', 'Verified', 'Promoted', 'Analytics', 'Edit', 'Delete',
  'Embed', 'Report', 'Block', 'Mute', 'Copy link', 'Download',
  'Image', 'Video', 'GIF', 'Photo',
  'Verified account', 'Square profile picture', 'Grok actions',
  'View post analytics', 'Share post', 'Post actions',
]);

// Regex patterns — matched against full token (start-anchored where possible)
const NOISE_PATTERNS = [
  /^\d[\d,]* repl(?:y|ies)/i,
  /^\d[\d,]* reposts?/i,
  /^\d[\d,]* likes?/i,
  /^\d[\d,]* bookmarks?/i,
  /^\d[\d,]* views?/i,
  /^\d[\d,]* quotes?/i,
  /^Repl(?:y|ies)\./i,
  /^Reposts?\./i,
  /^Likes?\./i,
  /^Views?\./i,
  /^\d+[smh]$/,                              // "2h", "30m"
  /^\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago$/i,  // "11 hours ago"
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/i,
];

// Substrings that disqualify an entire token (metadata injected by Twitter's ARIA)
const NOISE_SUBSTRINGS = [
  /verified account/i,
  /profile picture/i,
  /grok actions/i,
  /view post analytics/i,
  /post analytics/i,
  /share post/i,
];

let tabId = null;
let seen = new Set();
let tweets = [];
let sseClients = [];
let lastPoll = null;
let pollStatus = 'starting';

// ── camofox helpers ────────────────────────────────────────────────────────────

async function camofetch(path, method = 'GET', body = null, extraHeaders = {}) {
  const res = await fetch(`${CAMOFOX}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`camofox ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function createTab() {
  const res = await camofetch('/tabs', 'POST', { userId: USER_ID, sessionKey: SESSION_KEY });
  tabId = res.tabId;
  console.log(`[camofox] Tab created: ${tabId}`);
}

async function navigateTo(url) {
  return camofetch(`/tabs/${tabId}/navigate`, 'POST', { userId: USER_ID, sessionKey: SESSION_KEY, url });
}

async function getSnapshot() {
  return camofetch(`/tabs/${tabId}/snapshot?userId=${USER_ID}`);
}

async function importCookies(cookieArray) {
  return camofetch(`/sessions/${USER_ID}/cookies`, 'POST', { cookies: cookieArray });
}

// ── Cookie file parser ─────────────────────────────────────────────────────────

function normalizeSameSite(raw) {
  if (!raw) return undefined;
  const map = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', none: 'None' };
  return map[raw.toLowerCase()] ?? undefined;
}

function loadCookieFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();

  // JSON format (Cookie-Editor, EditThisCookie, etc.)
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter(c => c.domain?.includes('x.com') || c.domain?.includes('twitter.com'))
      .map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
        expires: c.expirationDate ?? c.expires ?? c.expiry ?? undefined,
        sameSite: normalizeSameSite(c.sameSite),
      }));
  }

  // Netscape format
  return raw.split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const [domain, , path, secure, expires, name, value] = l.split('\t');
      if (!name || !value) return null;
      return {
        name, value, domain,
        path: path || '/',
        secure: secure === 'TRUE',
        expires: parseInt(expires, 10) || undefined,
      };
    })
    .filter(Boolean)
    .filter(c => c.domain?.includes('x.com') || c.domain?.includes('twitter.com'));
}

// ── Snapshot parser ────────────────────────────────────────────────────────────

function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('base64url').slice(0, 20);
}

function extractTweetsFromYaml(yaml) {
  if (!yaml || typeof yaml !== 'string') return [];

  const lines = yaml.split('\n');
  const results = [];

  let inArticle = false;
  let articleIndent = -1;
  let bodyStarted = false;
  let inEngagement = false;
  let isPinned = false;
  let bodyTokens = [];

  function flushArticle() {
    if (!isPinned && bodyTokens.length > 0) {
      const text = bodyTokens.join('').replace(/\s{2,}/g, ' ').trim();
      if (text.length > 3) results.push({ id: hashText(text), text, ts: Date.now() });
    }
    bodyTokens = [];
    bodyStarted = false;
    inEngagement = false;
    isPinned = false;
  }

  for (const line of lines) {
    const indent = line.search(/\S/);
    if (indent === -1) continue;
    const content = line.trim();

    // ── Article boundary ─────────────────────────────────────────
    if (/^-\s+'?article/.test(content)) {
      if (inArticle) flushArticle();
      inArticle = true;
      articleIndent = indent;
      continue;
    }
    if (inArticle && indent <= articleIndent && content.startsWith('-')) {
      flushArticle();
      inArticle = false;
    }
    if (!inArticle) continue;

    // ── Engagement group — stop collecting ───────────────────────
    if (/^-\s+group\s+"[^"]*\d+\s+repl/i.test(content)) { inEngagement = true; continue; }
    if (inEngagement) continue;

    // ── Quote tweet boundary — stop collecting body here ─────────
    // "Quote" text node signals start of a nested quoted tweet
    if (/^-\s+text:\s+"?Quote"?$/.test(content)) { bodyStarted = false; continue; }
    // Nested blockquote role also signals quoted content
    if (/^-\s+blockquote/.test(content)) { bodyStarted = false; continue; }

    // ── Pinned tweet — mark and skip entire article ───────────────
    if (!bodyStarted && /^-\s+text:\s+"?Pinned"?$/.test(content)) { isPinned = true; continue; }
    if (isPinned) continue;

    // ── Header sentinel: body starts after "Grok actions"/"More" ─
    if (/^-\s+button\s+"(?:Grok actions|More)"/.test(content)) { bodyStarted = true; continue; }
    if (!bodyStarted) continue;

    // ── Skip remaining buttons and the media/photo links ─────────
    if (/^-\s+button/.test(content)) continue;
    if (/^-\s+link\s+"(?:Image|Photo|Video|GIF)"/.test(content)) continue;

    // ── Tweet body: bare text nodes ──────────────────────────────
    const textMatch = content.match(/^-\s+text:\s+(.+)/);
    if (textMatch) {
      let t = textMatch[1].trim();
      if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
      // Skip stat tokens: "19K", "1.2K", "341K", etc.
      if (/^\d[\d.,]*[KkMmBb]?$/.test(t)) continue;
      if (t && t !== '|' && t !== '·' && t !== '…') bodyTokens.push(t + ' ');
      continue;
    }

    // ── Emoji images ─────────────────────────────────────────────
    const imgMatch = content.match(/^-\s+img\s+"([^"]+)"/);
    if (imgMatch) {
      const alt = imgMatch[1];
      // Match emoji: Emoji_Presentation or single char with variation selector
      if (/^\p{Emoji_Presentation}/u.test(alt) || /^\p{Emoji}️/u.test(alt)) {
        bodyTokens.push(alt + ' ');
      }
      continue;
    }

    // ── Hashtags and @mentions inside tweet body ─────────────────
    const linkMatch = content.match(/^-\s+link\s+"([@#][^"]+)"/);
    if (linkMatch) bodyTokens.push(linkMatch[1] + ' ');
  }

  if (inArticle) flushArticle();

  const withinSeen = new Set();
  return results.filter(t => {
    if (withinSeen.has(t.id)) return false;
    withinSeen.add(t.id);
    return true;
  });
}

// ── SSE broadcast ──────────────────────────────────────────────────────────────

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

// ── Poll loop ──────────────────────────────────────────────────────────────────

async function poll() {
  pollStatus = 'polling';
  broadcast('status', { status: 'polling', lastPoll });
  console.log(`[poller] Polling ${TARGET}...`);

  try {
    if (!tabId) await createTab();

    await navigateTo(TARGET);

    // Brief pause for dynamic content to settle
    await new Promise(r => setTimeout(r, 4000));

    const res = await getSnapshot();

    const parsed = extractTweetsFromYaml(res.snapshot);

    let newCount = 0;
    // Reverse so oldest is unshifted first — newest ends up at front of array
    for (const tweet of [...parsed].reverse()) {
      if (!seen.has(tweet.id)) {
        seen.add(tweet.id);
        tweets.unshift(tweet);
        newCount++;
        broadcast('tweet', tweet);
      }
    }

    tweets = tweets.slice(0, 150); // keep last 150
    lastPoll = new Date().toISOString();
    pollStatus = 'ok';
    console.log(`[poller] ${parsed.length} tweets found, ${newCount} new. Total stored: ${tweets.length}`);
    broadcast('status', { status: 'ok', lastPoll, total: tweets.length, newCount });
  } catch (err) {
    pollStatus = 'error';
    console.error(`[poller] Error: ${err.message}`);
    broadcast('status', { status: 'error', message: err.message, lastPoll });
    tabId = null; // recreate tab next poll
  }
}

// ── Feed HTML ──────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CODLeague Live Feed</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0a0a;
      color: #e7e9ea;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
    }
    header {
      position: sticky; top: 0; z-index: 10;
      background: rgba(10,10,10,0.85);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid #2f3336;
      padding: 14px 20px;
      display: flex; align-items: center; gap: 10px;
    }
    .cod-badge {
      width: 32px; height: 32px; border-radius: 50%;
      background: linear-gradient(135deg, #ff6b00, #ffd200);
      display: flex; align-items: center; justify-content: center;
      font-weight: 900; font-size: 14px; color: #000; flex-shrink: 0;
    }
    header h1 { font-size: 17px; font-weight: 700; }
    header h1 span { color: #71767b; font-weight: 400; font-size: 14px; margin-left: 6px; }
    #indicator {
      margin-left: auto;
      display: flex; align-items: center; gap: 7px;
      font-size: 13px; color: #71767b;
    }
    #dot {
      width: 9px; height: 9px; border-radius: 50%;
      background: #71767b; flex-shrink: 0;
      transition: background 0.3s;
    }
    #dot.ok { background: #00ba7c; }
    #dot.polling { background: #ffd200; animation: pulse 1s ease-in-out infinite; }
    #dot.error { background: #f4212e; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
    #feed {
      max-width: 598px; margin: 0 auto;
      border-left: 1px solid #2f3336;
      border-right: 1px solid #2f3336;
      min-height: calc(100vh - 61px);
    }
    .tweet {
      padding: 14px 16px;
      border-bottom: 1px solid #2f3336;
      cursor: default;
      transition: background 0.15s;
    }
    .tweet:hover { background: #080808; }
    .tweet.new { animation: flash 1.2s ease-out; }
    @keyframes flash { 0%{ background:#12201a; } 100%{ background:transparent; } }
    .tweet-handle {
      font-weight: 700; font-size: 15px; color: #e7e9ea;
      display: flex; align-items: center; gap: 6px; margin-bottom: 5px;
    }
    .tweet-handle .at { font-weight: 400; color: #71767b; font-size: 14px; }
    .tweet-text {
      font-size: 15px; line-height: 1.55; color: #e7e9ea;
      white-space: pre-wrap; word-break: break-word;
    }
    .tweet-time { font-size: 13px; color: #71767b; margin-top: 8px; }
    #empty {
      text-align: center; padding: 80px 24px; color: #71767b;
    }
    #empty strong { font-size: 18px; color: #e7e9ea; display: block; margin-bottom: 8px; }
    #empty p { font-size: 14px; }
    #new-banner {
      display: none;
      position: sticky; top: 61px; z-index: 9;
      background: #1d9bf0;
      color: #fff; font-size: 14px; font-weight: 600;
      text-align: center; padding: 10px;
      cursor: pointer;
    }
    #new-banner:hover { background: #1a8cd8; }
  </style>
</head>
<body>
  <header>
    <div class="cod-badge">C</div>
    <h1>CODLeague <span>@CODLeague</span></h1>
    <div id="indicator">
      <div id="dot"></div>
      <span id="status-text">Connecting...</span>
    </div>
  </header>
  <div id="new-banner">Show new tweets</div>
  <div id="feed">
    <div id="empty">
      <strong>Waiting for tweets...</strong>
      <p>First poll takes ~30 seconds. Make sure camofox is running.</p>
    </div>
  </div>

  <script>
    const dot = document.getElementById('dot');
    const statusText = document.getElementById('status-text');
    const feed = document.getElementById('feed');
    const empty = document.getElementById('empty');
    const banner = document.getElementById('new-banner');

    let pendingTweets = [];
    let atTop = true;

    window.addEventListener('scroll', () => { atTop = window.scrollY < 100; });
    banner.addEventListener('click', () => {
      flushPending();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    function esc(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function timeStr(ts) {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function buildEl(tweet, isNew) {
      const el = document.createElement('div');
      el.className = 'tweet' + (isNew ? ' new' : '');
      el.dataset.id = tweet.id;
      el.innerHTML =
        '<div class="tweet-handle">CODLeague <span class="at">@CODLeague</span></div>' +
        '<div class="tweet-text">' + esc(tweet.text) + '</div>' +
        '<div class="tweet-time">Captured at ' + timeStr(tweet.ts) + '</div>';
      return el;
    }

    function flushPending() {
      pendingTweets.forEach(t => {
        if (!document.querySelector('[data-id="' + t.id + '"]')) {
          feed.insertBefore(buildEl(t, true), feed.firstChild);
        }
      });
      pendingTweets = [];
      banner.style.display = 'none';
    }

    // Load existing tweets on page load
    fetch('/tweets').then(r => r.json()).then(data => {
      if (data.length) {
        empty.style.display = 'none';
        data.forEach(t => feed.appendChild(buildEl(t, false)));
      }
    });

    // SSE
    const es = new EventSource('/events');

    es.addEventListener('tweet', e => {
      const t = JSON.parse(e.data);
      if (document.querySelector('[data-id="' + t.id + '"]')) return;
      empty.style.display = 'none';
      if (atTop) {
        feed.insertBefore(buildEl(t, true), feed.firstChild);
      } else {
        pendingTweets.push(t);
        banner.style.display = 'block';
        banner.textContent = 'Show ' + pendingTweets.length + ' new tweet' + (pendingTweets.length > 1 ? 's' : '');
      }
    });

    es.addEventListener('status', e => {
      const s = JSON.parse(e.data);
      dot.className = s.status;
      if (s.status === 'ok') {
        statusText.textContent = 'Updated ' + new Date(s.lastPoll).toLocaleTimeString() +
          ' · ' + s.total + ' tweets' + (s.newCount ? ' (+' + s.newCount + ' new)' : '');
      } else if (s.status === 'polling') {
        statusText.textContent = 'Polling…';
      } else {
        statusText.textContent = 'Error — retrying in 60s';
      }
    });

    es.onopen = () => { dot.className = 'ok'; };
    es.onerror = () => {
      dot.className = 'error';
      statusText.textContent = 'Connection lost — retrying…';
    };
  </script>
</body>
</html>`;

// ── HTTP server ────────────────────────────────────────────────────────────────

const CORS = { 'Access-Control-Allow-Origin': '*' };

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
    return res.end(HTML);
  }
  if (req.url === '/tweets') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify(tweets));
  }
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...CORS,
    });
    res.write(': connected\n\n');
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }
  res.writeHead(404, CORS);
  res.end('Not found');
});

// ── Startup ────────────────────────────────────────────────────────────────────

async function main() {
  const cookieFile = process.argv[2];

  server.listen(FEED_PORT, () => {
    console.log(`\n  Feed display → http://localhost:${FEED_PORT}\n`);
  });

  // Wait briefly for camofox to be ready
  console.log('[poller] Waiting for camofox on port 9377...');
  let ready = false;
  for (let i = 0; i < 15; i++) {
    try {
      await fetch(`${CAMOFOX}/health`);
      ready = true;
      break;
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!ready) {
    console.error('[poller] camofox not reachable. Make sure you ran: npm start (in the camofox-browser directory)');
    process.exit(1);
  }
  console.log('[poller] camofox is up.');

  if (cookieFile) {
    try {
      const cookies = loadCookieFile(cookieFile);
      if (cookies.length === 0) {
        console.warn('[poller] No x.com/twitter.com cookies found in file — continuing without auth.');
      } else {
        // Import cookies at the session level before creating any tab
        await importCookies(cookies);
        console.log(`[poller] Imported ${cookies.length} cookies.`);
      }
    } catch (err) {
      console.warn(`[poller] Cookie import failed (${err.message}) — continuing without auth.`);
    }
  }

  // First poll immediately, then every 60s
  await poll();
  setInterval(poll, POLL_MS);
}

main().catch(err => { console.error(err); process.exit(1); });
