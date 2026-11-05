const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'null']);

export function validateSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { ok: false, error: 'schema must be an object' };
  }
  if (schema.type !== 'object') {
    return { ok: false, error: 'top-level schema must have type: object' };
  }
  if (!schema.properties || typeof schema.properties !== 'object') {
    return { ok: false, error: 'schema must have a properties object' };
  }
  for (const [prop, def] of Object.entries(schema.properties)) {
    if (!def || typeof def !== 'object') {
      return { ok: false, error: `property "${prop}" must be an object` };
    }
    if (def.type && !SUPPORTED_TYPES.has(def.type)) {
      return { ok: false, error: `property "${prop}" has unsupported type "${def.type}"` };
    }
  }
  return { ok: true };
}

function coerceValue(raw, type) {
  if (raw == null) return null;
  if (type === 'string' || !type) return String(raw).trim();
  if (type === 'number') {
    const n = parseFloat(String(raw).replace(/[^0-9.eE+-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'integer') {
    const n = parseInt(String(raw).replace(/[^0-9-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') {
    const s = String(raw).toLowerCase().trim();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
    return null;
  }
  return raw;
}

function extractFromRef(refs, refId) {
  const info = refs.get(refId);
  if (!info) return null;
  return info.name || null;
}

export function extractDeterministic({ schema, refs }) {
  const check = validateSchema(schema);
  if (!check.ok) throw new Error(check.error);

  const result = {};
  for (const [prop, def] of Object.entries(schema.properties)) {
    const refId = def['x-ref'];

    let value = null;
    if (refId) {
      value = extractFromRef(refs, refId);
      if (value != null && def.type && def.type !== 'object') {
        value = coerceValue(value, def.type);
      }
    }

    if (value == null && Array.isArray(schema.required) && schema.required.includes(prop)) {
      throw new Error(`required property "${prop}" could not be extracted (x-ref=${refId || 'n/a'})`);
    }

    result[prop] = value;
  }

  return result;
}
/**
 * Structured extraction: turns a page into JSON, so the agent does not have to
 * read screenshots or raw text.
 *
 * Two halves:
 *   - collectPageData() runs inside the page (page.evaluate). It is self
 *     contained: it must not reference anything from this module, because its
 *     source text is sent to the browser. It returns raw strings only.
 *   - The functions below run in Node. They parse prices, tables and JSON-LD
 *     and are pure, so they are unit-tested without a browser.
 *
 * Read-only: nothing on the page is clicked, typed into, or changed.
 */

export const EXTRACT_KINDS = Object.freeze(['tables', 'prices', 'json_ld', 'listings']);

const CURRENCY_BY_SYMBOL = Object.freeze({
  '$': 'USD',
  'US$': 'USD',
  'A$': 'AUD',
  'C$': 'CAD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
  USD: 'USD',
  GBP: 'GBP',
  EUR: 'EUR',
  JPY: 'JPY',
});

const PRICE_RE = /(US\$|A\$|C\$|USD|GBP|EUR|JPY|[$£€¥])\s?(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d{1,2}))?/;
const MAX_AMOUNT = 1e9;

/**
 * Parse the first price in a string.
 * @returns {{amount: number, currency: string, text: string}|null}
 */
export function parsePrice(text) {
  const match = PRICE_RE.exec(String(text || ''));
  if (!match) return null;
  const [whole, fraction = ''] = [match[2].replace(/[,\s]/g, ''), match[3] || ''];
  const amount = Number(`${whole}.${(fraction + '00').slice(0, 2)}`);
  if (!Number.isFinite(amount) || amount > MAX_AMOUNT) return null;
  return {
    amount,
    currency: CURRENCY_BY_SYMBOL[match[1]] || match[1],
    text: match[0],
  };
}

/**
 * Turn a grid of cells into headers and rows. The first row is the header when
 * every cell in it has text and no two match; otherwise columns are named
 * col_1, col_2, and so on. Short rows are padded with empty strings.
 */
export function normalizeTable(grid) {
  const rows = (Array.isArray(grid) ? grid : []).filter((row) => Array.isArray(row) && row.length > 0);
  if (rows.length === 0) return { headers: [], rows: [] };

  const width = Math.max(...rows.map((row) => row.length));
  const first = rows[0].map((cell) => String(cell || '').trim());
  const headerOk = first.length === width
    && first.every((cell) => cell.length > 0)
    && new Set(first).size === first.length;

  const headers = headerOk
    ? first
    : Array.from({ length: width }, (_, i) => `col_${i + 1}`);
  const body = headerOk ? rows.slice(1) : rows;
  return {
    headers,
    rows: body.map((row) => Array.from({ length: width }, (_, i) => String(row[i] ?? '').trim())),
  };
}

/**
 * Parse JSON-LD script bodies. Invalid blocks are skipped and counted, never
 * thrown, because real pages often ship broken JSON-LD.
 * @returns {{items: unknown[], skipped: number}}
 */
export function parseJsonLd(blocks, { maxBlocks = 20 } = {}) {
  const items = [];
  let skipped = 0;
  for (const block of (Array.isArray(blocks) ? blocks : []).slice(0, maxBlocks)) {
    try {
      const value = JSON.parse(String(block));
      items.push(value);
    } catch {
      skipped += 1;
    }
  }
  return { items, skipped };
}

/**
 * Keep the first listing for each URL, and attach a parsed price.
 */
export function normalizeListings(raw) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const url = String(entry?.url || '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: String(entry.title || '').trim(),
      url,
      price: parsePrice(entry.priceText),
    });
  }
  return out;
}

/**
 * Build the response from the raw page data.
 * @param {object} raw output of collectPageData()
 * @param {string[]} kinds which parts to include
 */
export function buildExtraction(raw, kinds = EXTRACT_KINDS) {
  const want = new Set(kinds);
  const out = { url: String(raw?.url || ''), title: String(raw?.title || '') };

  if (want.has('tables')) {
    out.tables = (raw?.tables || []).map(normalizeTable).filter((t) => t.rows.length > 0);
  }
  if (want.has('json_ld')) {
    const { items, skipped } = parseJsonLd(raw?.json_ld || []);
    out.json_ld = { items, skipped };
  }
  if (want.has('prices')) {
    const prices = [];
    const seen = new Set();
    for (const text of raw?.prices || []) {
      const price = parsePrice(text);
      if (!price || seen.has(price.text)) continue;
      seen.add(price.text);
      prices.push({ ...price, source: String(text).slice(0, 120) });
    }
    out.prices = prices;
  }
  if (want.has('listings')) {
    out.listings = normalizeListings(raw?.listings || []);
  }
  return out;
}

/**
 * Runs in the page. Self contained: do not reference module imports or any
 * function defined outside this body.
 *
 * @param {object} limits optional caps, see the defaults below
 */
export function collectPageData(limits) {
  const L = Object.assign({
    tables: 30,
    rows: 200,
    cell: 300,
    scripts: 20,
    scriptChars: 100000,
    priceNodes: 500,
    scanNodes: 5000,
    listings: 200,
  }, limits || {});
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.getClientRects && el.getClientRects().length);
  const priceHint = /(US\$|A\$|C\$|USD|GBP|EUR|JPY|[$£€¥])\s?\d/;

  const tables = [];
  for (const table of Array.from(document.querySelectorAll('table'))) {
    if (tables.length >= L.tables) break;
    if (!visible(table)) continue;
    const grid = [];
    for (const tr of Array.from(table.rows)) {
      if (grid.length >= L.rows) break;
      grid.push(Array.from(tr.cells).map((cell) => clean(cell.innerText || cell.textContent).slice(0, L.cell)));
    }
    if (grid.length) tables.push(grid);
  }

  const json_ld = [];
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    if (json_ld.length >= L.scripts) break;
    const text = (script.textContent || '').slice(0, L.scriptChars);
    if (text.trim()) json_ld.push(text);
  }

  const prices = [];
  let scanned = 0;
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (scanned++ >= L.scanNodes || prices.length >= L.priceNodes) break;
    if (el.children.length > 2) continue;
    const text = clean(el.innerText || el.textContent);
    if (!text || text.length > 120 || !priceHint.test(text) || !visible(el)) continue;
    prices.push(text);
  }

  const listings = [];
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    if (listings.length >= L.listings) break;
    const title = clean(a.innerText || a.textContent).slice(0, 200);
    if (title.length < 5 || !visible(a)) continue;
    let node = a;
    let priceText = '';
    for (let i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement;
      const found = clean(node.innerText || node.textContent).match(/(US\$|A\$|C\$|USD|GBP|EUR|JPY|[$£€¥])\s?\d[\d,.]*/);
      if (found) {
        priceText = found[0];
        break;
      }
    }
    if (!priceText) continue;
    listings.push({ title, url: a.href, priceText });
  }

  return { url: location.href, title: document.title, tables, json_ld, prices, listings };
}
