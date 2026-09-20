function bindContextMember(context, value) {
  return typeof value === 'function' ? value.bind(context) : value;
}

const persistentContexts = new WeakSet();
const pageCloseQueues = new WeakMap();

const PERSISTENT_PROFILE_PREFS = Object.freeze({
  'browser.startup.page': 3,
  'browser.sessionstore.resume_from_crash': true,
  'browser.sessionstore.resume_session_once': true,
  'browser.sessionstore.privacy_level': 0,
  'privacy.sanitize.sanitizeOnShutdown': false,
  'privacy.clearOnShutdown.cookies': false,
  'privacy.clearOnShutdown.sessions': false,
  'privacy.clearOnShutdown.openWindows': false,
  'privacy.clearOnShutdown_v2.cookiesAndStorage': false,
});

function applyPersistentProfilePrefs(options = {}) {
  options.firefoxUserPrefs = {
    ...(options.firefoxUserPrefs || {}),
    ...PERSISTENT_PROFILE_PREFS,
  };
  return options;
}

function persistentContextLease(context) {
  return new Proxy(context, {
    get(target, property) {
      if (property === '_persistentContext') return context;
      if (property === '_persistentLease') return true;
      if (property === 'close') return async () => {};
      return bindContextMember(target, Reflect.get(target, property, target));
    },
  });
}

/**
 * Adapt Playwright's launchPersistentContext() result to the Browser-like
 * interface used by camofox-browser without allowing session cleanup to close
 * the single shared native context.
 */
function wrapPersistentContext(context) {
  persistentContexts.add(context);
  return {
    _persistentContext: context,
    isConnected: () => context.browser()?.isConnected?.() ?? false,
    close: async (...args) => context.close(...args),
    process: () => context.browser()?.process?.() ?? null,
    newContext: async (options = {}) => {
      if (Object.keys(options).length > 0) {
        throw new Error('Per-session BrowserContext options are unsupported for a native persistent profile');
      }
      return persistentContextLease(context);
    },
  };
}

function isPersistentContext(context) {
  if (!context) return false;
  const nativeContext = context._persistentContext || context;
  return persistentContexts.has(nativeContext);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout (${timeoutMs}ms)`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Firefox exits a launchPersistentContext browser when its final page closes.
 * Serialize page closes per context and retain the final page as about:blank so
 * normal tab/session cleanup cannot accidentally kill the persistent profile.
 */
async function closePagePreservingPersistentContext(page, closePage, { timeoutMs = 5000 } = {}) {
  const context = page?.context?.();
  if (!context || !isPersistentContext(context)) {
    await closePage();
    return { closed: true, retained: false };
  }

  const previous = pageCloseQueues.get(context) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    if (page.isClosed?.()) return { closed: false, retained: false };
    const livePages = context.pages().filter(candidate => !candidate.isClosed?.());
    if (livePages.length <= 1) {
      page.removeAllListeners?.();
      if (page.url?.() !== 'about:blank') {
        try {
          await withTimeout(
            page.goto('about:blank', { waitUntil: 'commit', timeout: timeoutMs }),
            timeoutMs,
            'persistent keepalive navigation'
          );
        } catch (_) {
          // A poisoned final page cannot be retained safely. Create a replacement
          // before closing it so Firefox never observes a zero-page context.
          const replacement = await context.newPage();
          await replacement.goto?.('about:blank', { waitUntil: 'commit', timeout: timeoutMs }).catch(() => {});
          await closePage();
          return { closed: true, retained: false };
        }
      }
      return { closed: false, retained: true };
    }

    await closePage();
    return { closed: true, retained: false };
  });
  pageCloseQueues.set(context, operation);
  try {
    return await operation;
  } finally {
    if (pageCloseQueues.get(context) === operation) pageCloseQueues.delete(context);
  }
}

/**
 * Verify browser responsiveness without mutating a human-visible persistent
 * page. Disposable browsers retain the existing isolated about:blank probe.
 */
async function probeBrowserHealth(browser, { timeoutMs = 5000 } = {}) {
  if (browser?._persistentContext) {
    const context = browser._persistentContext;
    const existing = context.pages().find(page => !page.isClosed?.());
    const page = existing || await context.newPage();
    // Keep a newly-created probe page alive. Closing the only page terminates a
    // Firefox persistent context and discards session cookies before checkpoint.
    await withTimeout(page.evaluate(() => true), timeoutMs, 'persistent browser health probe');
    return true;
  }

  let context;
  let page;
  try {
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto('about:blank', { timeout: timeoutMs });
    return true;
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

export {
  applyPersistentProfilePrefs,
  closePagePreservingPersistentContext,
  isPersistentContext,
  persistentContextLease,
  probeBrowserHealth,
  wrapPersistentContext,
};
