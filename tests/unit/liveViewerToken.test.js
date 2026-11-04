import { issueToken, verifyToken } from '../../plugins/live-viewer/index.js';
import { getControl, resetTabControl, setAgent, setHuman } from '../../lib/tab-control.js';

const SECRET = 'test-secret-key';

describe('live viewer tokens (unit)', () => {
  beforeEach(() => resetTabControl());

  test('a view token round-trips and carries no control claim', () => {
    const token = issueToken(SECRET, { userId: 'u1', tabId: 't1', ttlSeconds: 60 });
    const claims = verifyToken(SECRET, token);
    expect(claims).toMatchObject({ u: 'u1', t: 't1' });
    expect(claims.c).toBeUndefined();
  });

  test('a control token carries the control claim and handoff start time', () => {
    const token = issueToken(SECRET, { userId: 'u1', tabId: 't1', ttlSeconds: 60, control: true, handoffSince: 1234 });
    expect(verifyToken(SECRET, token)).toMatchObject({ c: 1, h: 1234 });
  });

  test('a token signed with another key is rejected', () => {
    const token = issueToken('other-key', { userId: 'u1', tabId: 't1', ttlSeconds: 60, control: true, handoffSince: 1 });
    expect(verifyToken(SECRET, token)).toBeNull();
  });

  test('tampering with the claims invalidates the signature', () => {
    const token = issueToken(SECRET, { userId: 'u1', tabId: 't1', ttlSeconds: 60 });
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'u1', t: 'other-tab', e: 9999999999 })).toString('base64url');
    expect(verifyToken(SECRET, `${forged}.${sig}`)).toBeNull();
  });

  test('a control claim cannot be added to a view token', () => {
    const token = issueToken(SECRET, { userId: 'u1', tabId: 't1', ttlSeconds: 60 });
    const [, sig] = token.split('.');
    const upgraded = Buffer.from(JSON.stringify({ u: 'u1', t: 't1', e: 9999999999, c: 1, h: 1 })).toString('base64url');
    expect(verifyToken(SECRET, `${upgraded}.${sig}`)).toBeNull();
  });

  test('expired tokens are rejected', () => {
    const token = issueToken(SECRET, { userId: 'u1', tabId: 't1', ttlSeconds: -10 });
    expect(verifyToken(SECRET, token)).toBeNull();
  });

  test('malformed input is rejected', () => {
    expect(verifyToken(SECRET, undefined)).toBeNull();
    expect(verifyToken(SECRET, 12345)).toBeNull();
    expect(verifyToken(SECRET, 'nodot')).toBeNull();
    expect(verifyToken(SECRET, '.sig')).toBeNull();
  });

  test('a handoff start time is required for a control token', () => {
    const token = issueToken(SECRET, { userId: 'u1', tabId: 't1', ttlSeconds: 60, control: true, handoffSince: undefined });
    expect(verifyToken(SECRET, token)).toBeNull();
  });
});

describe('handoff binding (unit)', () => {
  beforeEach(() => resetTabControl());

  test('a control link is bound to the handoff it was issued for', () => {
    const first = setHuman('tab-x', { now: 1000 });
    const claims = { c: 1, h: first.since, t: 'tab-x' };
    expect(getControl('tab-x', 1000).since).toBe(claims.h);

    // Handoff ends and a new one starts: the old start time no longer matches.
    setAgent('tab-x');
    const second = setHuman('tab-x', { now: 5000 });
    expect(second.since).not.toBe(claims.h);
  });
});
