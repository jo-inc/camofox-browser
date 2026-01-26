const { chromium } = require('playwright');
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '5mb' }));

let browser = null;
// userId -> { context, tabGroups: Map<listItemId, Map<tabId, TabState>>, lastAccess }
// TabState = { page, refs: Map<refId, {role, name, nth}>, visitedUrls: Set, toolCalls: number }
const sessions = new Map();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const MAX_SNAPSHOT_NODES = 500;

async function ensureBrowser() {
  if (!browser) {
    const launchOptions = {
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    };
    
    // Use CHROMIUM_PATH if set (for Docker/Fly.io), otherwise use Playwright's bundled browser
    if (process.env.CHROMIUM_PATH) {
      launchOptions.executablePath = process.env.CHROMIUM_PATH;
      console.log(`Using custom Chromium path: ${process.env.CHROMIUM_PATH}`);
    } else {
      console.log('Using Playwright bundled Chromium');
    }
    
    browser = await chromium.launch(launchOptions);
    console.log('Browser launched');
  }
  return browser;
}

async function getSession(userId) {
  let session = sessions.get(userId);
  if (!session) {
    const b = await ensureBrowser();
    const context = await b.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    session = { context, tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set(userId, session);
    console.log(`Session created for user ${userId}`);
  }
  session.lastAccess = Date.now();
  return session;
}

function getTabGroup(session, listItemId) {
  let group = session.tabGroups.get(listItemId);
  if (!group) {
    group = new Map();
    session.tabGroups.set(listItemId, group);
  }
  return group;
}

function findTab(session, tabId) {
  for (const [listItemId, group] of session.tabGroups) {
    if (group.has(tabId)) {
      const tabState = group.get(tabId);
      return { tabState, listItemId, group };
    }
  }
  return null;
}

function createTabState(page) {
  return {
    page,
    refs: new Map(),        // refId -> { role, name, nth }
    visitedUrls: new Set(), // URLs visited in this tab
    toolCalls: 0            // Track tool usage for validation
  };
}

// Wait for page to be ready for accessibility snapshot
async function waitForPageReady(page, options = {}) {
  const { timeout = 10000, waitForNetwork = true } = options;
  
  try {
    // Wait for DOM to be ready
    await page.waitForLoadState('domcontentloaded', { timeout });
    
    // Optionally wait for network to settle (useful for SPAs)
    if (waitForNetwork) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
        // networkidle can timeout on busy pages, that's ok
        console.log('waitForPageReady: networkidle timeout (continuing anyway)');
      });
    }
    
    // Small delay for JS frameworks to finish rendering
    await page.waitForTimeout(200);
    
    return true;
  } catch (err) {
    console.log(`waitForPageReady: ${err.message}`);
    return false;
  }
}

// Build element refs from aria snapshot (Playwright 1.48+ uses locator.ariaSnapshot())
async function buildRefs(page) {
  const refs = new Map();
  
  if (!page || page.isClosed()) {
    console.log('buildRefs: Page is closed or invalid');
    return refs;
  }
  
  // Wait for page to be ready before taking snapshot
  await waitForPageReady(page, { waitForNetwork: false });
  
  // Use the new ariaSnapshot API (Playwright 1.48+)
  // This returns a YAML string representation of the accessibility tree
  const ariaYaml = await page.locator('body').ariaSnapshot();
  
  if (!ariaYaml) {
    console.log('buildRefs: No aria snapshot available');
    return refs;
  }
  
  // Parse the YAML to extract interactive elements
  // Format: "- role \"name\"" or "- role \"name\" [attr=value]"
  const lines = ariaYaml.split('\n');
  let refCounter = 1;
  
  const interactiveRoles = [
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'menuitem', 'tab', 'searchbox', 'slider', 'spinbutton', 'switch'
  ];
  
  for (const line of lines) {
    if (refCounter > MAX_SNAPSHOT_NODES) break;
    
    // Match patterns like "- button \"Click me\"" or "- link \"Home\""
    const match = line.match(/^\s*-\s+(\w+)(?:\s+"([^"]*)")?/);
    if (match) {
      const [, role, name] = match;
      if (interactiveRoles.includes(role.toLowerCase())) {
        const refId = `e${refCounter++}`;
        refs.set(refId, { role: role.toLowerCase(), name: name || '', nth: 0 });
      }
    }
  }
  
  return refs;
}

// Get aria snapshot as YAML string (new Playwright API)
async function getAriaSnapshot(page) {
  if (!page || page.isClosed()) {
    return null;
  }
  await waitForPageReady(page, { waitForNetwork: false });
  return await page.locator('body').ariaSnapshot();
}

// Resolve ref to Playwright locator (like Clawdbot's refLocator)
function refToLocator(page, ref, refs) {
  const info = refs.get(ref);
  if (!info) return null;
  
  const { role, name, nth } = info;
  let locator = page.getByRole(role, name ? { name } : undefined);
  
  if (nth > 0) {
    locator = locator.nth(nth);
  }
  
  return locator;
}

// Format accessibility tree as compact text (like Clawdbot's AI snapshot format)
function formatSnapshotAsText(snapshot, refs) {
  const lines = [];
  
  function walk(node, indent = 0) {
    if (!node) return;
    
    const { role, name, value, children } = node;
    const prefix = '  '.repeat(indent);
    
    // Find if this node has a ref
    let refLabel = '';
    for (const [refId, info] of refs) {
      if (info.role === (role || '').toLowerCase() && info.name === (name || '')) {
        refLabel = `[${refId}] `;
        break;
      }
    }
    
    // Build node description
    let desc = role || 'unknown';
    if (name) desc += ` "${name}"`;
    if (value) desc += ` = ${value}`;
    
    lines.push(`${prefix}${refLabel}${desc}`);
    
    if (children) {
      for (const child of children) {
        walk(child, indent + 1);
      }
    }
  }
  
  walk(snapshot);
  return lines.join('\n');
}

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, sessions: sessions.size });
});

// List all tab groups for user
app.get('/tabs', async (req, res) => {
  const userId = req.query.userId;
  const session = sessions.get(userId);
  if (!session) return res.json({ tabGroups: {} });
  
  const tabGroups = {};
  for (const [listItemId, group] of session.tabGroups) {
    tabGroups[listItemId] = [];
    for (const [tabId, tabState] of group) {
      tabGroups[listItemId].push({ 
        tabId, 
        url: tabState.page.url(),
        toolCalls: tabState.toolCalls,
        visitedCount: tabState.visitedUrls.size
      });
    }
  }
  res.json({ tabGroups });
});

// List tabs for specific list item
app.get('/tabs/group/:listItemId', async (req, res) => {
  const userId = req.query.userId;
  const session = sessions.get(userId);
  const group = session?.tabGroups.get(req.params.listItemId);
  if (!group) return res.json({ tabs: [] });
  
  const tabs = [];
  for (const [tabId, tabState] of group) {
    tabs.push({ 
      tabId, 
      url: tabState.page.url(),
      toolCalls: tabState.toolCalls,
      visitedCount: tabState.visitedUrls.size
    });
  }
  res.json({ tabs });
});

// Create new tab in a tab group
app.post('/tabs', async (req, res) => {
  try {
    const { userId, listItemId, url } = req.body;
    if (!listItemId) return res.status(400).json({ error: 'listItemId required' });
    
    const session = await getSession(userId);
    const group = getTabGroup(session, listItemId);
    const tabId = crypto.randomUUID();
    const page = await session.context.newPage();
    const tabState = createTabState(page);
    
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      tabState.visitedUrls.add(url);
      tabState.toolCalls++;
    }
    
    group.set(tabId, tabState);
    console.log(`Tab ${tabId} created for user ${userId} in group ${listItemId}`);
    res.json({ tabId, listItemId, url: page.url() });
  } catch (err) {
    console.error('Create tab error:', err);
    res.status(500).json({ error: err.message });
  }
});

// URL macro expansion (like Jo's FnBrowserOpenMacroUrl)
const URL_MACROS = {
  '@google_search': (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  '@youtube_search': (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  '@amazon_search': (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  '@reddit_search': (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
  '@wikipedia_search': (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
  '@twitter_search': (q) => `https://twitter.com/search?q=${encodeURIComponent(q)}`,
  '@yelp_search': (q) => `https://www.yelp.com/search?find_desc=${encodeURIComponent(q)}`,
  '@spotify_search': (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}`,
  '@netflix_search': (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}`,
  '@linkedin_search': (q) => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(q)}`,
  '@instagram_search': (q) => `https://www.instagram.com/explore/tags/${encodeURIComponent(q.replace(/\s+/g, ''))}`,
  '@tiktok_search': (q) => `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`,
  '@twitch_search': (q) => `https://www.twitch.tv/search?term=${encodeURIComponent(q)}`,
};

// Navigate tab (supports URL or macro)
app.post('/tabs/:tabId/navigate', async (req, res) => {
  try {
    const { userId, url, macro, query } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    let targetUrl = url;
    
    // Handle macro expansion
    if (macro) {
      const expander = URL_MACROS[macro];
      if (!expander) return res.status(400).json({ error: `Unknown macro: ${macro}` });
      targetUrl = expander(query || '');
    }
    
    if (!targetUrl) return res.status(400).json({ error: 'url or macro required' });
    
    await tabState.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    tabState.visitedUrls.add(targetUrl);
    tabState.toolCalls++;
    tabState.refs.clear(); // Clear refs on navigation
    
    res.json({ ok: true, url: tabState.page.url() });
  } catch (err) {
    console.error('Navigate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Go back in history
app.post('/tabs/:tabId/back', async (req, res) => {
  try {
    const { userId } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    await tabState.page.goBack({ timeout: 10000 }).catch(() => {});
    tabState.refs.clear();
    
    res.json({ ok: true, url: tabState.page.url() });
  } catch (err) {
    console.error('Back error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Go forward in history
app.post('/tabs/:tabId/forward', async (req, res) => {
  try {
    const { userId } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    await tabState.page.goForward({ timeout: 10000 }).catch(() => {});
    tabState.refs.clear();
    
    res.json({ ok: true, url: tabState.page.url() });
  } catch (err) {
    console.error('Forward error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Refresh page
app.post('/tabs/:tabId/refresh', async (req, res) => {
  try {
    const { userId } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    await tabState.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    tabState.refs.clear();
    
    res.json({ ok: true, url: tabState.page.url() });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Wait for page to be ready (explicit wait endpoint)
app.post('/tabs/:tabId/wait', async (req, res) => {
  try {
    const { userId, timeout = 10000, waitForNetwork = true } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    const ready = await waitForPageReady(tabState.page, { timeout, waitForNetwork });
    
    res.json({ 
      ok: ready, 
      url: tabState.page.url(),
      message: ready ? 'Page is ready' : 'Page may still be loading'
    });
  } catch (err) {
    console.error('Wait error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get accessibility snapshot with element refs
app.get('/tabs/:tabId/snapshot', async (req, res) => {
  try {
    const userId = req.query.userId;
    const format = req.query.format || 'json'; // 'json' or 'text'
    const waitForReady = req.query.wait !== 'false'; // Default: wait for page
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState, listItemId } = found;
    const page = tabState.page;
    
    // Validate page state
    if (!page || page.isClosed()) {
      return res.status(500).json({ error: 'Page is closed or invalid' });
    }
    
    // Wait for page to be ready before taking snapshot
    if (waitForReady) {
      await waitForPageReady(page, { waitForNetwork: true });
    }
    
    // Build refs from aria snapshot (uses new Playwright API)
    const refs = await buildRefs(page);
    tabState.refs = refs;
    tabState.toolCalls++;
    
    // Get aria snapshot as YAML (new Playwright 1.48+ API)
    let ariaSnapshot = await getAriaSnapshot(page);
    
    // Retry once if snapshot is empty
    if (!ariaSnapshot) {
      console.log('Snapshot empty, retrying after short wait...');
      await page.waitForTimeout(500);
      ariaSnapshot = await getAriaSnapshot(page);
    }
    
    if (!ariaSnapshot) {
      return res.status(500).json({ 
        error: 'Failed to get aria snapshot - page may not be ready',
        url: page.url(),
        hint: 'Try waiting longer or check if the page loaded correctly'
      });
    }
    
    // Convert refs Map to plain object for JSON response
    const refsObj = {};
    for (const [refId, info] of refs) {
      refsObj[refId] = info;
    }
    
    // Both formats now return the YAML aria snapshot (text is more token efficient)
    res.json({
      snapshot: ariaSnapshot,
      refs: refsObj,
      url: page.url(),
      title: await page.title(),
      listItemId,
      format: 'text'
    });
  } catch (err) {
    console.error('Snapshot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Click element (by ref or selector)
app.post('/tabs/:tabId/click', async (req, res) => {
  try {
    const { userId, ref, selector } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    if (ref) {
      // Use ref-based clicking (like Clawdbot)
      const locator = refToLocator(tabState.page, ref, tabState.refs);
      if (!locator) return res.status(400).json({ error: `Unknown ref: ${ref}` });
      await locator.click({ timeout: 10000 });
    } else if (selector) {
      await tabState.page.click(selector, { timeout: 10000 });
    } else {
      return res.status(400).json({ error: 'ref or selector required' });
    }
    
    await tabState.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    
    // Track if URL changed
    const newUrl = tabState.page.url();
    tabState.visitedUrls.add(newUrl);
    
    res.json({ ok: true, url: newUrl });
  } catch (err) {
    console.error('Click error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Type into element (by ref or selector)
app.post('/tabs/:tabId/type', async (req, res) => {
  try {
    const { userId, ref, selector, text } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    if (ref) {
      const locator = refToLocator(tabState.page, ref, tabState.refs);
      if (!locator) return res.status(400).json({ error: `Unknown ref: ${ref}` });
      await locator.fill(text, { timeout: 10000 });
    } else if (selector) {
      await tabState.page.fill(selector, text, { timeout: 10000 });
    } else {
      return res.status(400).json({ error: 'ref or selector required' });
    }
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Type error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Press key
app.post('/tabs/:tabId/press', async (req, res) => {
  try {
    const { userId, key } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    await tabState.page.keyboard.press(key);
    res.json({ ok: true });
  } catch (err) {
    console.error('Press error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Scroll down
app.post('/tabs/:tabId/scroll', async (req, res) => {
  try {
    const { userId, direction = 'down', amount = 500 } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    const delta = direction === 'up' ? -amount : amount;
    await tabState.page.mouse.wheel(0, delta);
    await tabState.page.waitForTimeout(300); // Let content load
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Scroll error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all links from page
app.get('/tabs/:tabId/links', async (req, res) => {
  try {
    const userId = req.query.userId;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    // Extract all links from page
    const allLinks = await tabState.page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        const text = a.textContent?.trim().slice(0, 100) || '';
        if (href && href.startsWith('http')) {
          links.push({ url: href, text });
        }
      });
      return links;
    });
    
    const total = allLinks.length;
    const paginated = allLinks.slice(offset, offset + limit);
    
    res.json({
      links: paginated,
      pagination: {
        total,
        offset,
        limit,
        hasMore: offset + limit < total
      }
    });
  } catch (err) {
    console.error('Links error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Screenshot (for debugging)
app.get('/tabs/:tabId/screenshot', async (req, res) => {
  try {
    const userId = req.query.userId;
    const fullPage = req.query.fullPage === 'true';
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    const buffer = await tabState.page.screenshot({ 
      type: 'png',
      fullPage
    });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error('Screenshot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get tab stats (visited URLs, tool calls)
app.get('/tabs/:tabId/stats', async (req, res) => {
  try {
    const userId = req.query.userId;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState, listItemId } = found;
    res.json({
      tabId: req.params.tabId,
      listItemId,
      url: tabState.page.url(),
      visitedUrls: Array.from(tabState.visitedUrls),
      toolCalls: tabState.toolCalls,
      refsCount: tabState.refs.size
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Close tab
app.delete('/tabs/:tabId', async (req, res) => {
  try {
    const { userId } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (found) {
      await found.tabState.page.close();
      found.group.delete(req.params.tabId);
      if (found.group.size === 0) {
        session.tabGroups.delete(found.listItemId);
      }
      console.log(`Tab ${req.params.tabId} closed for user ${userId}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Close tab error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Close all tabs for a list item (conversation ended)
app.delete('/tabs/group/:listItemId', async (req, res) => {
  try {
    const { userId } = req.body;
    const session = sessions.get(userId);
    const group = session?.tabGroups.get(req.params.listItemId);
    if (group) {
      for (const [tabId, tabState] of group) {
        await tabState.page.close().catch(() => {});
      }
      session.tabGroups.delete(req.params.listItemId);
      console.log(`Tab group ${req.params.listItemId} closed for user ${userId}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Close tab group error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Close all tabs for user
app.delete('/sessions/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const session = sessions.get(userId);
    if (session) {
      await session.context.close();
      sessions.delete(userId);
      console.log(`Session closed for user ${userId}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Close session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Cleanup stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions) {
    if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
      session.context.close().catch(() => {});
      sessions.delete(userId);
      console.log(`Session expired for user ${userId}`);
    }
  }
}, 60_000);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  for (const [userId, session] of sessions) {
    await session.context.close().catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`jo-browser listening on port ${PORT}`);
});
