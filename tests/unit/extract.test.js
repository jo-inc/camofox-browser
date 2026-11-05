import { validateSchema, extractDeterministic } from '../../lib/extract.js';

function makeRefs(entries) {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Simulate the POST /tabs/:tabId/extract handler logic without a real server.
// This mirrors the exact decision tree in server.js so we can unit-test every
// HTTP-level status code path.
// ---------------------------------------------------------------------------

/**
 * Minimal replica of the extract route handler.
 * Accepts the same {userId, schema} body plus a sessions Map and tabId.
 * Returns { status, body } matching what the endpoint would send.
 */
function simulateExtractHandler({ tabId, body, sessions }) {
  const { userId, schema } = body || {};
  if (!userId) return { status: 400, body: { error: 'userId is required' } };
  if (!schema) return { status: 400, body: { error: 'schema is required' } };

  const check = validateSchema(schema);
  if (!check.ok) return { status: 400, body: { error: check.error } };

  const normalizedId = String(userId);
  const session = sessions.get(normalizedId);
  // findTab replica: search tabGroups for matching tabId
  let tabState = null;
  if (session) {
    for (const [, group] of session.tabGroups) {
      const ts = group.get(tabId);
      if (ts) { tabState = ts; break; }
    }
  }
  if (!tabState) return { status: 404, body: { error: 'Tab not found' } };

  session.lastAccess = Date.now();
  tabState.toolCalls++;
  tabState.consecutiveTimeouts = 0;

  if (!tabState.refs || tabState.refs.size === 0) {
    return {
      status: 409,
      body: {
        error: 'no refs available -- call GET /tabs/:tabId/snapshot first to build the ref table',
        snapshot: tabState.lastSnapshot || null,
      },
    };
  }

  try {
    const data = extractDeterministic({ schema, refs: tabState.refs });
    return { status: 200, body: { ok: true, data } };
  } catch (extractErr) {
    return {
      status: 422,
      body: { ok: false, error: extractErr.message, snapshot: tabState.lastSnapshot || null },
    };
  }
}

/** Build a sessions Map containing one user + one tab for testing. */
function buildSessions({ userId = 'u1', tabId = 't1', refs = null, lastSnapshot = null } = {}) {
  const tabState = {
    refs,
    lastSnapshot,
    toolCalls: 0,
    consecutiveTimeouts: 0,
  };
  const tabGroup = new Map([[tabId, tabState]]);
  const session = {
    tabGroups: new Map([['default', tabGroup]]),
    lastAccess: 0,
  };
  return { sessions: new Map([[userId, session]]), tabState };
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

// ===========================================================================
// Endpoint handler simulation tests
// These exercise the same logic as POST /tabs/:tabId/extract without a server.
// ===========================================================================

describe('POST /tabs/:tabId/extract (handler logic)', () => {
  const PAGE_REFS = makeRefs([
    ['e1', { role: 'heading', name: 'Example Domain', nth: 0 }],
    ['e2', { role: 'link', name: 'Learn more', nth: 0 }],
    ['e3', { role: 'button', name: 'Submit', nth: 0 }],
    ['e4', { role: 'text', name: '  42  ', nth: 0 }],
    ['e5', { role: 'text', name: '$19.99', nth: 0 }],
    ['e6', { role: 'text', name: 'true', nth: 0 }],
  ]);

  // --- 200: successful extraction -------------------------------------------

  test('200: extracts multiple properties with mixed types', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'u1',
        schema: {
          type: 'object',
          properties: {
            title:  { type: 'string',  'x-ref': 'e1' },
            link:   { type: 'string',  'x-ref': 'e2' },
            count:  { type: 'integer', 'x-ref': 'e4' },
            price:  { type: 'number',  'x-ref': 'e5' },
            flag:   { type: 'boolean', 'x-ref': 'e6' },
          },
          required: ['title'],
        },
      },
      sessions,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      title: 'Example Domain',
      link:  'Learn more',
      count: 42,
      price: 19.99,
      flag:  true,
    });
  });

  test('200: optional missing ref resolves to null', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'u1',
        schema: {
          type: 'object',
          properties: {
            present: { type: 'string', 'x-ref': 'e1' },
            absent:  { type: 'string', 'x-ref': 'e9999' },
          },
        },
      },
      sessions,
    });

    expect(status).toBe(200);
    expect(body.data.present).toBe('Example Domain');
    expect(body.data.absent).toBeNull();
  });

  test('200: increments toolCalls on success', () => {
    const { sessions, tabState } = buildSessions({ refs: PAGE_REFS });
    expect(tabState.toolCalls).toBe(0);

    simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'u1',
        schema: {
          type: 'object',
          properties: { x: { type: 'string', 'x-ref': 'e1' } },
        },
      },
      sessions,
    });

    expect(tabState.toolCalls).toBe(1);
  });

  // --- 400: bad requests ----------------------------------------------------

  test('400: missing userId', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: { schema: { type: 'object', properties: {} } },
      sessions,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/userId/i);
  });

  test('400: missing schema', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: { userId: 'u1' },
      sessions,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/schema/i);
  });

  test('400: schema with unsupported type', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'u1',
        schema: { type: 'object', properties: { x: { type: 'foobar' } } },
      },
      sessions,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/foobar/);
  });

  test('400: schema root type is not object', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'u1',
        schema: { type: 'array', items: { type: 'string' } },
      },
      sessions,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/object/i);
  });

  test('400: schema missing properties key', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'u1',
        schema: { type: 'object' },
      },
      sessions,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/properties/i);
  });

  test('400: empty body', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {},
      sessions,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/userId/i);
  });

  // --- 404: tab not found ---------------------------------------------------

  test('404: nonexistent tab', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 'does-not-exist',
      body: {
        userId: 'u1',
        schema: { type: 'object', properties: { x: { type: 'string', 'x-ref': 'e1' } } },
      },
      sessions,
    });

    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  test('404: valid tab but wrong userId', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'wrong-user',
        schema: { type: 'object', properties: { x: { type: 'string', 'x-ref': 'e1' } } },
      },
      sessions,
    });

    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  // --- 409: no refs (snapshot not called) ------------------------------------

  test('409: refs is null (snapshot never called)', () => {
    const { sessions } = buildSessions({ refs: null, lastSnapshot: null });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'u1',
        schema: { type: 'object', properties: { x: { type: 'string', 'x-ref': 'e1' } } },
      },
      sessions,
    });

    expect(status).toBe(409);
    expect(body.error).toMatch(/refs/i);
    expect(body.snapshot).toBeNull();
  });

  test('409: refs is empty Map', () => {
    const { sessions } = buildSessions({ refs: new Map(), lastSnapshot: 'some old snapshot' });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'u1',
        schema: { type: 'object', properties: { x: { type: 'string', 'x-ref': 'e1' } } },
      },
      sessions,
    });

    expect(status).toBe(409);
    expect(body.error).toMatch(/refs/i);
    expect(body.snapshot).toBe('some old snapshot');
  });

  // --- 422: extraction failure (required ref missing) -----------------------

  test('422: required property ref not in ref table', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS, lastSnapshot: '[heading e1] Example' });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'u1',
        schema: {
          type: 'object',
          properties: { missing: { type: 'string', 'x-ref': 'e9999' } },
          required: ['missing'],
        },
      },
      sessions,
    });

    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/required/);
    expect(body.snapshot).toBe('[heading e1] Example');
  });

  test('422: multiple required, second one missing', () => {
    const { sessions } = buildSessions({ refs: PAGE_REFS });
    const { status, body } = simulateExtractHandler({
      tabId: 't1',
      body: {
        userId: 'u1',
        schema: {
          type: 'object',
          properties: {
            title:   { type: 'string', 'x-ref': 'e1' },
            phantom: { type: 'string', 'x-ref': 'e8888' },
          },
          required: ['title', 'phantom'],
        },
      },
      sessions,
    });

    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/phantom/);
  });
});
