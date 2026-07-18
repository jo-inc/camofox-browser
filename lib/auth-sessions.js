const PRESETS = {
  amazon: {
    name: 'amazon',
    domain: 'amazon.com',
    verifyUrl: 'https://www.amazon.com/gp/css/order-history',
    loginUrlPatterns: [
      /\/ap\/signin/i,
      /\/ap\/mfa/i,
      /\/gp\/signin/i,
      /\/errors\/validateCaptcha/i,
    ],
    loginTextPatterns: [
      /sign in/i,
      /email or mobile phone number/i,
      /enter your password/i,
      /authentication required/i,
      /two-step verification/i,
    ],
  },
};

export function authSessionPreset(name) {
  const key = String(name || '').toLowerCase();
  return PRESETS[key] || null;
}

export function listAuthSessionPresets() {
  return Object.keys(PRESETS);
}

export function cookieMatchesSuffix(cookie, suffix) {
  const domain = String(cookie?.domain || '').toLowerCase().replace(/^\./, '');
  const cleanSuffix = String(suffix || '').toLowerCase().replace(/^\./, '');
  return domain === cleanSuffix || domain.endsWith(`.${cleanSuffix}`);
}

export function normalizeAuthSessionSpec(input = {}) {
  const preset = authSessionPreset(input.provider || input.preset);
  const domain = String(input.domain || preset?.domain || '').toLowerCase().replace(/^\./, '');
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) || domain.includes('..')) {
    throw new Error('auth session domain is required');
  }

  const verifyUrl = input.verifyUrl || preset?.verifyUrl || null;
  if (verifyUrl) {
    const parsed = new URL(verifyUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('verifyUrl must be http or https');
    }
    if (!cookieMatchesSuffix({ domain: parsed.hostname }, domain)) {
      throw new Error('verifyUrl host must match auth session domain');
    }
  }

  return {
    name: String(input.name || input.provider || input.preset || domain),
    domain,
    verifyUrl,
    loginUrlPatterns: preset?.loginUrlPatterns || [/\/login/i, /\/signin/i, /\/sign-in/i, /\/auth/i],
    loginTextPatterns: preset?.loginTextPatterns || [/sign in/i, /log in/i, /login/i, /enter your password/i, /authentication required/i],
  };
}

export function sanitizeAuthSessionCookies(spec, cookies) {
  if (!Array.isArray(cookies)) {
    throw new Error('cookies must be an array');
  }
  if (cookies.length > 500) {
    throw new Error('Too many cookies. Maximum 500 per request.');
  }

  const allowedFields = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];
  const sanitized = [];
  const invalid = [];
  const rejectedDomains = [];

  for (let i = 0; i < cookies.length; i++) {
    const c = cookies[i];
    const missing = [];
    if (!c || typeof c !== 'object') {
      invalid.push({ index: i, error: 'cookie must be an object' });
      continue;
    }
    if (typeof c.name !== 'string' || !c.name) missing.push('name');
    if (typeof c.value !== 'string') missing.push('value');
    if (typeof c.domain !== 'string' || !c.domain) missing.push('domain');
    if (missing.length) {
      invalid.push({ index: i, missing });
      continue;
    }
    if (!cookieMatchesSuffix(c, spec.domain)) {
      rejectedDomains.push({ index: i, domain: c.domain });
      continue;
    }
    const clean = {};
    for (const k of allowedFields) {
      if (c[k] !== undefined) clean[k] = c[k];
    }
    if (!clean.path) clean.path = '/';
    sanitized.push(clean);
  }

  if (invalid.length || rejectedDomains.length) {
    const err = new Error('Invalid auth session cookies');
    err.invalid = invalid;
    err.rejectedDomains = rejectedDomains;
    throw err;
  }

  return sanitized;
}

export async function verifyAuthSessionPage(page, spec) {
  if (!spec.verifyUrl) {
    throw new Error('verifyUrl is required for auth session verification');
  }
  await page.goto(spec.verifyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const url = page.url();
  const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const loginWall = spec.loginUrlPatterns.some((pattern) => pattern.test(url)) ||
    spec.loginTextPatterns.some((pattern) => pattern.test(text));
  return {
    name: spec.name,
    domain: spec.domain,
    status: loginWall ? 'needs_reauth' : 'valid',
    authenticated: !loginWall,
    url,
    verifiedAt: new Date().toISOString(),
  };
}
