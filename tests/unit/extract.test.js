import { validateSchema, extractDeterministic } from '../../lib/extract.js';

function makeRefs(entries) {
  return new Map(entries);
}

describe('validateSchema', () => {
  test('rejects missing schema', () => {
    expect(validateSchema(null).ok).toBe(false);
    expect(validateSchema(undefined).ok).toBe(false);
    expect(validateSchema('nope').ok).toBe(false);
  });

  test('rejects non-object root', () => {
    expect(validateSchema({ type: 'string' }).ok).toBe(false);
    expect(validateSchema({ type: 'array' }).ok).toBe(false);
  });

  test('rejects missing properties', () => {
    expect(validateSchema({ type: 'object' }).ok).toBe(false);
    expect(validateSchema({ type: 'object', properties: null }).ok).toBe(false);
  });

  test('rejects unsupported property types', () => {
    const r = validateSchema({ type: 'object', properties: { x: { type: 'nope' } } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nope/);
  });

  test('accepts well-formed schema', () => {
    expect(validateSchema({
      type: 'object',
      properties: {
        title: { type: 'string', 'x-ref': 'e1' },
        count: { type: 'integer', 'x-ref': 'e2' },
      },
      required: ['title'],
    }).ok).toBe(true);
  });
});

describe('extractDeterministic', () => {
  const refs = makeRefs([
    ['e1', { role: 'heading', name: 'Example Domain', nth: 0 }],
    ['e2', { role: 'link', name: 'Learn more', nth: 0 }],
    ['e3', { role: 'button', name: 'Submit', nth: 0 }],
    ['e4', { role: 'text', name: '  42  ', nth: 0 }],
  ]);

  test('pulls name from refs by x-ref', () => {
    const data = extractDeterministic({
      schema: {
        type: 'object',
        properties: { title: { type: 'string', 'x-ref': 'e1' } },
      },
      refs,
    });
    expect(data).toEqual({ title: 'Example Domain' });
  });

  test('coerces strings to integers', () => {
    const data = extractDeterministic({
      schema: {
        type: 'object',
        properties: { count: { type: 'integer', 'x-ref': 'e4' } },
      },
      refs,
    });
    expect(data).toEqual({ count: 42 });
  });

  test('coerces strings to numbers', () => {
    const numRefs = makeRefs([['e1', { role: 'text', name: '$19.99', nth: 0 }]]);
    const data = extractDeterministic({
      schema: {
        type: 'object',
        properties: { price: { type: 'number', 'x-ref': 'e1' } },
      },
      refs: numRefs,
    });
    expect(data).toEqual({ price: 19.99 });
  });

  test('throws on missing required ref', () => {
    expect(() => extractDeterministic({
      schema: {
        type: 'object',
        properties: { missing: { type: 'string', 'x-ref': 'e999' } },
        required: ['missing'],
      },
      refs,
    })).toThrow(/required/);
  });

  test('returns null for unresolved optional property', () => {
    const data = extractDeterministic({
      schema: {
        type: 'object',
        properties: { maybe: { type: 'string', 'x-ref': 'e999' } },
      },
      refs,
    });
    expect(data).toEqual({ maybe: null });
  });

  test('throws on invalid schema before extraction', () => {
    expect(() => extractDeterministic({
      schema: { type: 'array' },
      refs,
    })).toThrow(/type: object/);
  });

  test('handles empty refs map', () => {
    const data = extractDeterministic({
      schema: {
        type: 'object',
        properties: { x: { type: 'string', 'x-ref': 'e1' } },
      },
      refs: new Map(),
    });
    expect(data).toEqual({ x: null });
  });

  test('boolean coercion handles common representations', () => {
    const booleanRefs = makeRefs([
      ['e1', { role: 'text', name: 'true', nth: 0 }],
      ['e2', { role: 'text', name: 'FALSE', nth: 0 }],
      ['e3', { role: 'text', name: 'yes', nth: 0 }],
      ['e4', { role: 'text', name: 'maybe', nth: 0 }],
    ]);
    const data = extractDeterministic({
      schema: {
        type: 'object',
        properties: {
          a: { type: 'boolean', 'x-ref': 'e1' },
          b: { type: 'boolean', 'x-ref': 'e2' },
          c: { type: 'boolean', 'x-ref': 'e3' },
          d: { type: 'boolean', 'x-ref': 'e4' },
        },
      },
      refs: booleanRefs,
    });
    expect(data).toEqual({ a: true, b: false, c: true, d: null });
  });

  test('returns multiple refs in one call', () => {
    const data = extractDeterministic({
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string', 'x-ref': 'e1' },
          linkText: { type: 'string', 'x-ref': 'e2' },
          buttonLabel: { type: 'string', 'x-ref': 'e3' },
        },
        required: ['title'],
      },
      refs,
    });
    expect(data).toEqual({
      title: 'Example Domain',
      linkText: 'Learn more',
      buttonLabel: 'Submit',
    });
  });
});
