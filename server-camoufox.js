require('dotenv').config();
const { Camoufox, launchOptions } = require('camoufox-js');
const { firefox } = require('playwright-core');
const express = require('express');
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(express.json({ limit: '5mb' }));

let browser = null;
// userId -> { context, tabGroups: Map<listItemId, Map<tabId, TabState>>, lastAccess }
// TabState = { page, refs: Map<refId, {role, name, nth}>, visitedUrls: Set, toolCalls: number }
const sessions = new Map();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const MAX_SNAPSHOT_NODES = 500;
const DEBUG_RESPONSES = true; // Log response payloads

function logResponse(endpoint, data) {
  if (!DEBUG_RESPONSES) return;
  let logData = data;
  // Truncate snapshot for readability
  if (data && data.snapshot) {
    const snap = data.snapshot;
    logData = { ...data, snapshot: `[${snap.length} chars] ${snap.slice(0, 300)}...` };
  }
  console.log(`📤 ${endpoint} ->`, JSON.stringify(logData, null, 2));
}

// Per-tab locks to serialize operations on the same tab
// tabId -> Promise (the currently executing operation)
const tabLocks = new Map();

async function withTabLock(tabId, operation) {
  // Wait for any pending operation on this tab to complete
  const pending = tabLocks.get(tabId);
  if (pending) {
    try {
      await pending;
    } catch (e) {
      // Previous operation failed, continue anyway
    }
  }
  
  // Execute this operation and store the promise
  const promise = operation();
  tabLocks.set(tabId, promise);
  
  try {
    return await promise;
  } finally {
    // Clean up if this is still the active lock
    if (tabLocks.get(tabId) === promise) {
      tabLocks.delete(tabId);
    }
  }
}

// Detect host OS for fingerprint generation
function getHostOS() {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

function getProxyConfig() {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const username = process.env.PROXY_USERNAME;
  const password = process.env.PROXY_PASSWORD;
  
  if (host && port) {
    console.log(`🔒 Using ISP proxy: ${host}:${port}`);
    return {
      server: `http://${host}:${port}`,
      username,
      password,
    };
  }
  return null;
}

async function ensureBrowser() {
  if (!browser) {
    const hostOS = getHostOS();
    const proxy = getProxyConfig();
    console.log(`Launching Camoufox browser (host OS: ${hostOS})...`);
    
    // Use launchOptions for more control, then launch with firefox
    const launchConfig = {
      headless: true,
      // Generate fingerprints matching the host OS to avoid detection
      os: hostOS,
      // Enable humanized cursor movement
      humanize: true,
      // Enable cache for better performance
      enable_cache: true,
    };
    
    // Add proxy if configured
    if (proxy) {
      launchConfig.proxy = proxy;
      launchConfig.i_know_what_im_doing = true; // Suppress geoip warning on fallback
      // Try with geoip first, fall back without if it fails
      launchConfig.geoip = true;
      try {
        const options = await launchOptions(launchConfig);
        browser = await firefox.launch(options);
        console.log('Camoufox browser launched with ISP proxy + geoip');
        return browser;
      } catch (err) {
        console.log(`geoip lookup failed (${err.message}), retrying without geoip...`);
        launchConfig.geoip = false;
      }
    }
    
    const options = await launchOptions(launchConfig);
    browser = await firefox.launch(options);
    console.log('Camoufox browser launched' + (proxy ? ' with ISP proxy' : ''));
  }
  return browser;
}

async function getSession(userId) {
  let session = sessions.get(userId);
  if (!session) {
    const b = await ensureBrowser();
    const context = await b.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      geolocation: { latitude: 37.7749, longitude: -122.4194 },
      permissions: ['geolocation'],
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
    refs: new Map(),
    visitedUrls: new Set(),
    toolCalls: 0
  };
}

async function waitForPageReady(page, options = {}) {
  const { timeout = 10000, waitForNetwork = true } = options;
  
  try {
    await page.waitForLoadState('domcontentloaded', { timeout });
    
    if (waitForNetwork) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
        console.log('waitForPageReady: networkidle timeout (continuing anyway)');
      });
    }
    
    // Framework hydration wait (React/Next.js/Vue) - mirrors Swift WebView.swift logic
    // Wait for readyState === 'complete' + network quiet (40 iterations × 250ms max)
    await page.evaluate(async () => {
      for (let i = 0; i < 40; i++) {
        // Check if network is quiet (no recent resource loads)
        const entries = performance.getEntriesByType('resource');
        const recentEntries = entries.slice(-5);
        const netQuiet = recentEntries.every(e => (performance.now() - e.responseEnd) > 400);
        
        if (document.readyState === 'complete' && netQuiet) {
          // Double RAF to ensure paint is complete
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          break;
        }
        await new Promise(r => setTimeout(r, 250));
      }
    }).catch(() => {
      console.log('waitForPageReady: framework hydration wait failed (continuing anyway)');
    });
    
    await page.waitForTimeout(200);
    
    // Auto-dismiss common consent/privacy dialogs
    await dismissConsentDialogs(page);
    
    return true;
  } catch (err) {
    console.log(`waitForPageReady: ${err.message}`);
    return false;
  }
}

async function dismissConsentDialogs(page) {
  // Common consent/privacy dialog selectors (matches Swift WebView.swift patterns)
  const dismissSelectors = [
    // OneTrust (very common)
    '#onetrust-banner-sdk button#onetrust-accept-btn-handler',
    '#onetrust-banner-sdk button#onetrust-reject-all-handler',
    '#onetrust-close-btn-container button',
    // Generic patterns
    'button[data-test="cookie-accept-all"]',
    'button[aria-label="Accept all"]',
    'button[aria-label="Accept All"]',
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
    // Dialog close buttons
    'dialog button:has-text("Close")',
    'dialog button:has-text("Accept")',
    'dialog button:has-text("I Accept")',
    'dialog button:has-text("Got it")',
    'dialog button:has-text("OK")',
    // GDPR/CCPA specific
    '[class*="consent"] button[class*="accept"]',
    '[class*="consent"] button[class*="close"]',
    '[class*="privacy"] button[class*="close"]',
    '[class*="cookie"] button[class*="accept"]',
    '[class*="cookie"] button[class*="close"]',
    // Overlay close buttons
    '[class*="modal"] button[class*="close"]',
    '[class*="overlay"] button[class*="close"]',
  ];
  
  for (const selector of dismissSelectors) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 100 })) {
        await button.click({ timeout: 1000 }).catch(() => {});
        console.log(`🍪 Auto-dismissed consent dialog via: ${selector}`);
        await page.waitForTimeout(300); // Brief pause after dismiss
        break; // Only dismiss one dialog per page load
      }
    } catch (e) {
      // Selector not found or not clickable, continue
    }
  }
}

async function buildRefs(page) {
  const refs = new Map();
  
  if (!page || page.isClosed()) {
    console.log('buildRefs: Page is closed or invalid');
    return refs;
  }
  
  await waitForPageReady(page, { waitForNetwork: false });
  
  // Get ARIA snapshot including shadow DOM content
  // Playwright's ariaSnapshot already traverses shadow roots, but we also
  // inject a script to collect shadow DOM elements for additional coverage
  let ariaYaml;
  try {
    ariaYaml = await page.locator('body').ariaSnapshot({ timeout: 10000 });
  } catch (err) {
    console.log('buildRefs: ariaSnapshot failed, retrying after navigation settles');
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    ariaYaml = await page.locator('body').ariaSnapshot({ timeout: 10000 });
  }
  
  // Collect additional interactive elements from shadow DOM
  const shadowElements = await page.evaluate(() => {
    const elements = [];
    const collectFromShadow = (root, depth = 0) => {
      if (depth > 5) return; // Limit recursion
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (el.shadowRoot) {
          collectFromShadow(el.shadowRoot, depth + 1);
        }
      }
    };
    // Start collection from all shadow roots
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) collectFromShadow(el.shadowRoot);
    });
    return elements;
  }).catch(() => []);
  
  if (!ariaYaml) {
    console.log('buildRefs: No aria snapshot available');
    return refs;
  }
  
  const lines = ariaYaml.split('\n');
  let refCounter = 1;
  
  // Interactive roles to include - exclude combobox to avoid opening complex widgets
  // (date pickers, dropdowns) that can interfere with navigation
  const interactiveRoles = [
    'button', 'link', 'textbox', 'checkbox', 'radio',
    'menuitem', 'tab', 'searchbox', 'slider', 'spinbutton', 'switch'
    // 'combobox' excluded - can trigger date pickers and complex dropdowns
  ];
  
  // Patterns to skip (date pickers, calendar widgets)
  const skipPatterns = [
    /date/i, /calendar/i, /picker/i, /datepicker/i
  ];
  
  // Track occurrences of each role+name combo for nth disambiguation
  const seenCounts = new Map(); // "role:name" -> count
  
  for (const line of lines) {
    if (refCounter > MAX_SNAPSHOT_NODES) break;
    
    const match = line.match(/^\s*-\s+(\w+)(?:\s+"([^"]*)")?/);
    if (match) {
      const [, role, name] = match;
      const normalizedRole = role.toLowerCase();
      
      // Skip combobox role entirely (date pickers, complex dropdowns)
      if (normalizedRole === 'combobox') continue;
      
      // Skip elements with date/calendar-related names
      if (name && skipPatterns.some(p => p.test(name))) continue;
      
      if (interactiveRoles.includes(normalizedRole)) {
        const normalizedName = name || '';
        const key = `${normalizedRole}:${normalizedName}`;
        
        // Get current count and increment
        const nth = seenCounts.get(key) || 0;
        seenCounts.set(key, nth + 1);
        
        const refId = `e${refCounter++}`;
        refs.set(refId, { role: normalizedRole, name: normalizedName, nth });
      }
    }
  }
  
  return refs;
}

async function getAriaSnapshot(page) {
  if (!page || page.isClosed()) {
    return null;
  }
  await waitForPageReady(page, { waitForNetwork: false });
  return await page.locator('body').ariaSnapshot({ timeout: 10000 });
}

function refToLocator(page, ref, refs) {
  const info = refs.get(ref);
  if (!info) return null;
  
  const { role, name, nth } = info;
  let locator = page.getByRole(role, name ? { name } : undefined);
  
  // Always use .nth() to disambiguate duplicate role+name combinations
  // This avoids "strict mode violation" when multiple elements match
  locator = locator.nth(nth);
  
  return locator;
}

// Health check
app.get('/health', async (req, res) => {
  try {
    const b = await ensureBrowser();
    res.json({ 
      ok: true, 
      engine: 'camoufox',
      sessions: sessions.size,
      browserConnected: b.isConnected()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create new tab
app.post('/tabs', async (req, res) => {
  try {
    const { userId, listItemId, url } = req.body;
    if (!userId || !listItemId) {
      return res.status(400).json({ error: 'userId and listItemId required' });
    }
    
    const session = await getSession(userId);
    const group = getTabGroup(session, listItemId);
    
    const page = await session.context.newPage();
    const tabId = crypto.randomUUID();
    const tabState = createTabState(page);
    group.set(tabId, tabState);
    
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      tabState.visitedUrls.add(url);
    }
    
    console.log(`Tab ${tabId} created for user ${userId}, listItem ${listItemId}`);
    res.json({ tabId, url: page.url() });
  } catch (err) {
    console.error('Create tab error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Navigate
app.post('/tabs/:tabId/navigate', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, url, macro, query } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    let targetUrl = url;
    if (macro) {
      const macros = {
        '@google_search': `https://www.google.com/search?q=${encodeURIComponent(query || '')}`,
        '@youtube_search': `https://www.youtube.com/results?search_query=${encodeURIComponent(query || '')}`,
        '@amazon_search': `https://www.amazon.com/s?k=${encodeURIComponent(query || '')}`,
        '@reddit_search': `https://www.reddit.com/search/?q=${encodeURIComponent(query || '')}`,
        '@wikipedia_search': `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query || '')}`,
        '@twitter_search': `https://twitter.com/search?q=${encodeURIComponent(query || '')}`,
        '@yelp_search': `https://www.yelp.com/search?find_desc=${encodeURIComponent(query || '')}`,
        '@spotify_search': `https://open.spotify.com/search/${encodeURIComponent(query || '')}`,
        '@netflix_search': `https://www.netflix.com/search?q=${encodeURIComponent(query || '')}`,
        '@linkedin_search': `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query || '')}`,
        '@instagram_search': `https://www.instagram.com/explore/tags/${encodeURIComponent(query || '')}`,
        '@tiktok_search': `https://www.tiktok.com/search?q=${encodeURIComponent(query || '')}`,
        '@twitch_search': `https://www.twitch.tv/search?term=${encodeURIComponent(query || '')}`
      };
      targetUrl = macros[macro] || url;
    }
    
    if (!targetUrl) {
      return res.status(400).json({ error: 'url or macro required' });
    }
    
    // Serialize navigation operations on the same tab
    const result = await withTabLock(tabId, async () => {
      await tabState.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      tabState.visitedUrls.add(targetUrl);
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    });
    
    logResponse(`POST /tabs/${tabId}/navigate`, result);
    res.json(result);
  } catch (err) {
    console.error('Navigate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Snapshot
app.get('/tabs/:tabId/snapshot', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    const format = req.query.format || 'text';
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    tabState.refs = await buildRefs(tabState.page);
    
    const ariaYaml = await getAriaSnapshot(tabState.page);
    
    // Annotate YAML with ref IDs for interactive elements
    let annotatedYaml = ariaYaml || '';
    if (annotatedYaml && tabState.refs.size > 0) {
      // Build a map of role+name -> refId for annotation
      const refsByKey = new Map();
      const seenCounts = new Map();
      for (const [refId, info] of tabState.refs) {
        const key = `${info.role}:${info.name}:${info.nth}`;
        refsByKey.set(key, refId);
      }
      
      // Track occurrences while annotating
      const annotationCounts = new Map();
      const lines = annotatedYaml.split('\n');
      // Must match buildRefs - excludes combobox to avoid date pickers/complex dropdowns
      const interactiveRoles = [
        'button', 'link', 'textbox', 'checkbox', 'radio',
        'menuitem', 'tab', 'searchbox', 'slider', 'spinbutton', 'switch'
      ];
      const skipPatterns = [/date/i, /calendar/i, /picker/i, /datepicker/i];
      
      annotatedYaml = lines.map(line => {
        const match = line.match(/^(\s*-\s+)(\w+)(\s+"([^"]*)")?(.*)$/);
        if (match) {
          const [, prefix, role, nameMatch, name, suffix] = match;
          const normalizedRole = role.toLowerCase();
          
          // Skip combobox and date-related elements (same as buildRefs)
          if (normalizedRole === 'combobox') return line;
          if (name && skipPatterns.some(p => p.test(name))) return line;
          
          if (interactiveRoles.includes(normalizedRole)) {
            const normalizedName = name || '';
            const countKey = `${normalizedRole}:${normalizedName}`;
            const nth = annotationCounts.get(countKey) || 0;
            annotationCounts.set(countKey, nth + 1);
            
            const key = `${normalizedRole}:${normalizedName}:${nth}`;
            const refId = refsByKey.get(key);
            if (refId) {
              return `${prefix}${role}${nameMatch || ''} [${refId}]${suffix}`;
            }
          }
        }
        return line;
      }).join('\n');
    }
    
    const result = {
      url: tabState.page.url(),
      snapshot: annotatedYaml,
      refsCount: tabState.refs.size
    };
    logResponse(`GET /tabs/${req.params.tabId}/snapshot`, result);
    res.json(result);
  } catch (err) {
    console.error('Snapshot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Wait for page ready
app.post('/tabs/:tabId/wait', async (req, res) => {
  try {
    const { userId, timeout = 10000, waitForNetwork = true } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    const ready = await waitForPageReady(tabState.page, { timeout, waitForNetwork });
    
    res.json({ ok: true, ready });
  } catch (err) {
    console.error('Wait error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Click
app.post('/tabs/:tabId/click', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, ref, selector } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    if (!ref && !selector) {
      return res.status(400).json({ error: 'ref or selector required' });
    }
    
    const result = await withTabLock(tabId, async () => {
      // Full mouse event sequence for stubborn JS click handlers (mirrors Swift WebView.swift)
      // Dispatches: mouseover → mouseenter → mousedown → mouseup → click
      const dispatchMouseSequence = async (locator) => {
        const box = await locator.boundingBox();
        if (!box) throw new Error('Element not visible (no bounding box)');
        
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        
        // Move mouse to element (triggers mouseover/mouseenter)
        await tabState.page.mouse.move(x, y);
        await tabState.page.waitForTimeout(50);
        
        // Full click sequence
        await tabState.page.mouse.down();
        await tabState.page.waitForTimeout(50);
        await tabState.page.mouse.up();
        
        console.log(`🖱️ Dispatched full mouse sequence at (${x.toFixed(0)}, ${y.toFixed(0)})`);
      };
      
      const doClick = async (locatorOrSelector, isLocator) => {
        const locator = isLocator ? locatorOrSelector : tabState.page.locator(locatorOrSelector);
        
        try {
          // First try normal click (respects visibility, enabled, not-obscured)
          await locator.click({ timeout: 5000 });
        } catch (err) {
          // Fallback 1: If intercepted by overlay, retry with force
          if (err.message.includes('intercepts pointer events')) {
            console.log('Click intercepted, retrying with force:true');
            try {
              await locator.click({ timeout: 5000, force: true });
            } catch (forceErr) {
              // Fallback 2: Full mouse event sequence for stubborn JS handlers
              console.log('Force click failed, trying full mouse sequence');
              await dispatchMouseSequence(locator);
            }
          } else if (err.message.includes('not visible') || err.message.includes('timeout')) {
            // Fallback 2: Element not responding to click, try mouse sequence
            console.log('Click timeout/not visible, trying full mouse sequence');
            await dispatchMouseSequence(locator);
          } else {
            throw err;
          }
        }
      };
      
      if (ref) {
        const locator = refToLocator(tabState.page, ref, tabState.refs);
        if (!locator) {
          const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none';
          throw new Error(`Unknown ref: ${ref} (valid refs: e1-${maxRef}, ${tabState.refs.size} total). Refs reset after navigation - call snapshot first.`);
        }
        await doClick(locator, true);
      } else {
        await doClick(selector, false);
      }
      
      await tabState.page.waitForTimeout(500);
      tabState.refs = await buildRefs(tabState.page);
      
      const newUrl = tabState.page.url();
      tabState.visitedUrls.add(newUrl);
      return { ok: true, url: newUrl };
    });
    
    logResponse(`POST /tabs/${tabId}/click`, result);
    res.json(result);
  } catch (err) {
    console.error('Click error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Type
app.post('/tabs/:tabId/type', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, ref, selector, text } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    if (!ref && !selector) {
      return res.status(400).json({ error: 'ref or selector required' });
    }
    
    await withTabLock(tabId, async () => {
      if (ref) {
        const locator = refToLocator(tabState.page, ref, tabState.refs);
        if (!locator) throw new Error(`Unknown ref: ${ref}`);
        await locator.fill(text, { timeout: 10000 });
      } else {
        await tabState.page.fill(selector, text, { timeout: 10000 });
      }
    });
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Type error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Press key
app.post('/tabs/:tabId/press', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, key } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    await withTabLock(tabId, async () => {
      await tabState.page.keyboard.press(key);
    });
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Press error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Scroll
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
    await tabState.page.waitForTimeout(300);
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Scroll error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Back
app.post('/tabs/:tabId/back', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    const result = await withTabLock(tabId, async () => {
      await tabState.page.goBack({ timeout: 10000 });
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    });
    
    res.json(result);
  } catch (err) {
    console.error('Back error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Forward
app.post('/tabs/:tabId/forward', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    const result = await withTabLock(tabId, async () => {
      await tabState.page.goForward({ timeout: 10000 });
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    });
    
    res.json(result);
  } catch (err) {
    console.error('Forward error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Refresh
app.post('/tabs/:tabId/refresh', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(userId);
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    const result = await withTabLock(tabId, async () => {
      await tabState.page.reload({ timeout: 30000 });
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    });
    
    res.json(result);
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get links
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
      pagination: { total, offset, limit, hasMore: offset + limit < total }
    });
  } catch (err) {
    console.error('Links error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Screenshot
app.get('/tabs/:tabId/screenshot', async (req, res) => {
  try {
    const userId = req.query.userId;
    const fullPage = req.query.fullPage === 'true';
    const session = sessions.get(userId);
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    const buffer = await tabState.page.screenshot({ type: 'png', fullPage });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error('Screenshot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stats
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

// Close tab group
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

// Close session
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
app.listen(PORT, async () => {
  console.log(`🦊 jo-browser [Camoufox/Firefox] listening on port ${PORT}`);
  // Pre-launch browser so it's ready for first request
  await ensureBrowser().catch(err => {
    console.error('Failed to pre-launch browser:', err.message);
  });
});
