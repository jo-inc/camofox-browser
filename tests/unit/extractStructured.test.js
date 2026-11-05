import { buildExtraction, normalizeListings, normalizeTable, parseJsonLd, parsePrice } from '../../lib/extract.js';

describe('parsePrice (unit)', () => {
  test.each([
    ['$1,299.99', 1299.99, 'USD'],
    ['£45', 45, 'GBP'],
    ['€12.5', 12.5, 'EUR'],
    ['US$8.00', 8, 'USD'],
    ['A$19', 19, 'AUD'],
    ['USD 1 299', 1299, 'USD'],
    ['Now $24.9 only', 24.9, 'USD'],
  ])('parses %s', (text, amount, currency) => {
    const price = parsePrice(text);
    expect(price).toMatchObject({ amount, currency });
  });

  test('returns null when there is no price', () => {
    expect(parsePrice('Free shipping')).toBeNull();
    expect(parsePrice('')).toBeNull();
    expect(parsePrice(undefined)).toBeNull();
  });

  test('refuses absurd amounts', () => {
    expect(parsePrice('$9,999,999,999')).toBeNull();
  });
});

describe('normalizeTable (unit)', () => {
  test('uses the first row as headers when they are unique and filled', () => {
    expect(normalizeTable([['Model', 'Price'], ['A', '$10'], ['B', '$20']])).toEqual({
      headers: ['Model', 'Price'],
      rows: [['A', '$10'], ['B', '$20']],
    });
  });

  test('names columns when the first row is not a usable header', () => {
    const out = normalizeTable([['', 'Price'], ['A', '$10']]);
    expect(out.headers).toEqual(['col_1', 'col_2']);
    expect(out.rows).toEqual([['', 'Price'], ['A', '$10']]);
  });

  test('pads short rows', () => {
    const out = normalizeTable([['a', 'b', 'c'], ['1']]);
    expect(out.rows).toEqual([['1', '', '']]);
  });

  test('empty input gives empty output', () => {
    expect(normalizeTable([])).toEqual({ headers: [], rows: [] });
    expect(normalizeTable(null)).toEqual({ headers: [], rows: [] });
  });
});

describe('parseJsonLd (unit)', () => {
  test('parses valid blocks and counts broken ones without throwing', () => {
    const { items, skipped } = parseJsonLd(['{"@type":"Product","name":"Hub"}', '{not json', '[1,2]']);
    expect(items).toEqual([{ '@type': 'Product', name: 'Hub' }, [1, 2]]);
    expect(skipped).toBe(1);
  });

  test('caps the number of blocks', () => {
    const blocks = Array.from({ length: 30 }, () => '{}');
    expect(parseJsonLd(blocks, { maxBlocks: 5 }).items).toHaveLength(5);
  });
});

describe('normalizeListings (unit)', () => {
  test('keeps one entry per URL and attaches a parsed price', () => {
    const out = normalizeListings([
      { title: 'USB-C hub', url: 'https://shop.test/a', priceText: '$29.99' },
      { title: 'USB-C hub again', url: 'https://shop.test/a', priceText: '$29.99' },
      { title: 'No url', url: '', priceText: '$1' },
    ]);
    expect(out).toEqual([
      { title: 'USB-C hub', url: 'https://shop.test/a', price: { amount: 29.99, currency: 'USD', text: '$29.99' } },
    ]);
  });
});

describe('buildExtraction (unit)', () => {
  const raw = {
    url: 'https://shop.test/hubs',
    title: 'Hubs',
    tables: [[['Model', 'Price'], ['X1', '$10']]],
    json_ld: ['{"@type":"Product"}', 'broken'],
    prices: ['$10', '$10', '$20.50', 'no price here'],
    listings: [{ title: 'X1 hub', url: 'https://shop.test/x1', priceText: '$10' }],
  };

  test('returns all four parts by default', () => {
    const out = buildExtraction(raw);
    expect(out.url).toBe('https://shop.test/hubs');
    expect(out.tables[0].headers).toEqual(['Model', 'Price']);
    expect(out.json_ld).toEqual({ items: [{ '@type': 'Product' }], skipped: 1 });
    expect(out.prices.map((p) => p.amount)).toEqual([10, 20.5]);
    expect(out.listings).toHaveLength(1);
  });

  test('returns only the requested parts', () => {
    const out = buildExtraction(raw, ['prices']);
    expect(out.prices).toBeDefined();
    expect(out.tables).toBeUndefined();
    expect(out.json_ld).toBeUndefined();
    expect(out.listings).toBeUndefined();
  });
});
