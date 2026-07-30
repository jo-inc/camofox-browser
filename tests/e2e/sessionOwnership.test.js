import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';
import { createClient } from '../helpers/client.js';

const OWNER_A = 'owner_A-0123456789abcdefghijklmnopqrstuvwxyz';
const OWNER_B = 'owner_B-0123456789abcdefghijklmnopqrstuvwxyz';

describe('exclusive session ownership API', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer(0, { SESSION_TIMEOUT_MS: '30000' });
    serverUrl = getServerUrl();
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('claims an absent session atomically and protects reuse and cleanup', async () => {
    const client = createClient(serverUrl);
    let claimed = false;
    try {
      const first = await client.request('POST', '/tabs', {
        userId: client.userId,
        sessionKey: client.sessionKey,
        url: `${testSiteUrl}/pageA`,
        exclusiveSession: true,
        sessionOwnerToken: OWNER_A,
      });
      claimed = true;

      expect(first.tabId).toBeDefined();
      expect(first.sessionOwned).toBe(true);

      await expect(client.request(
        'GET',
        `/tabs/${first.tabId}/snapshot?userId=${client.userId}`,
      )).rejects.toMatchObject({
        status: 403,
        data: { code: 'session_owner_mismatch' },
      });
      const ownedSnapshot = await client.request(
        'GET',
        `/tabs/${first.tabId}/snapshot?userId=${client.userId}`,
        null,
        { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
      );
      expect(ownedSnapshot.url).toBe(`${testSiteUrl}/pageA`);

      await expect(client.request(
        'DELETE',
        `/tabs/${first.tabId}?userId=${client.userId}`,
        { userId: 'unclaimed-decoy-user' },
      )).rejects.toMatchObject({
        status: 400,
        data: { code: 'conflicting_session_user_id' },
      });
      const snapshotAfterRejectedDelete = await client.request(
        'GET',
        `/tabs/${first.tabId}/snapshot?userId=${client.userId}`,
        null,
        { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
      );
      expect(snapshotAfterRejectedDelete.url).toBe(`${testSiteUrl}/pageA`);

      await expect(client.request(
        'GET',
        `/sessions/${client.userId}/traces`,
      )).rejects.toMatchObject({
        status: 403,
        data: { code: 'session_owner_mismatch' },
      });
      await expect(client.request(
        'DELETE',
        `/sessions/${client.userId}/storage_state`,
      )).rejects.toMatchObject({
        status: 403,
        data: { code: 'session_owner_mismatch' },
      });
      await expect(client.request(
        'GET',
        `/sessions/${client.userId}/traces`,
        null,
        { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
      )).resolves.toBeDefined();

      await expect(client.request('POST', '/tabs', {
        userId: client.userId,
        sessionKey: 'competing-group',
        exclusiveSession: true,
        sessionOwnerToken: OWNER_B,
      })).rejects.toMatchObject({
        status: 409,
        data: { code: 'session_ownership_conflict' },
      });

      await expect(client.request('POST', '/tabs', {
        userId: client.userId,
        sessionKey: 'competing-group',
      })).rejects.toMatchObject({
        status: 403,
        data: { code: 'session_owner_mismatch' },
      });

      await expect(client.request('POST', '/tabs/open', {
        userId: client.userId,
        listItemId: 'legacy-competing-group',
        url: `${testSiteUrl}/pageA`,
      })).rejects.toMatchObject({
        status: 403,
        data: { code: 'session_owner_mismatch' },
      });

      const legacyOwned = await client.request('POST', '/tabs/open', {
        userId: client.userId,
        listItemId: 'legacy-owned-group',
        url: `${testSiteUrl}/pageA`,
      }, {
        headers: { 'X-Camofox-Session-Owner': OWNER_A },
      });
      expect(legacyOwned.tabId).toBeDefined();

      const second = await client.request('POST', '/tabs', {
        userId: client.userId,
        sessionKey: 'owned-group',
        sessionOwnerToken: OWNER_A,
      });
      expect(second.sessionOwned).toBe(true);

      await expect(client.request('DELETE', `/sessions/${client.userId}`, {
        sessionOwnerToken: OWNER_B,
      })).rejects.toMatchObject({
        status: 403,
        data: { code: 'session_owner_mismatch' },
      });

      const activeOperation = client.request('POST', `/tabs/${first.tabId}/evaluate`, {
        userId: client.userId,
        expression: 'new Promise(resolve => setTimeout(() => resolve("operation-finished"), 300))',
      }, {
        headers: { 'X-Camofox-Session-Owner': OWNER_A },
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      let deletionSettled = false;
      const serializedDelete = client.request(
        'DELETE',
        `/sessions/${client.userId}`,
        null,
        { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
      ).then(result => {
        deletionSettled = true;
        return result;
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(deletionSettled).toBe(false);
      await expect(client.request(
        'GET',
        `/tabs/${first.tabId}/snapshot?userId=${client.userId}`,
        null,
        { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
      )).rejects.toMatchObject({
        status: 409,
        data: { code: 'session_deletion_inflight' },
      });
      await expect(activeOperation).resolves.toMatchObject({
        ok: true,
        result: 'operation-finished',
      });
      await expect(serializedDelete).resolves.toMatchObject({
        ok: true,
        claimReleased: true,
      });
      claimed = false;
    } finally {
      if (claimed) {
        await client.request('DELETE', `/sessions/${client.userId}`, {
          sessionOwnerToken: OWNER_A,
        }).catch(() => {});
      }
    }
  }, 120000);

  test('rejects ambiguous exclusive-session and owner-token inputs', async () => {
    const client = createClient(serverUrl);
    for (const invalidUserId of ['undefined', 'null', '', ['array'], { object: true }]) {
      await expect(client.request('POST', '/tabs', {
        userId: invalidUserId,
        sessionKey: 'invalid-user',
        exclusiveSession: true,
        sessionOwnerToken: OWNER_A,
      })).rejects.toMatchObject({
        status: 400,
        data: { code: 'invalid_session_user_id' },
      });
    }

    await expect(client.request('POST', '/tabs', {
      userId: client.userId,
      sessionKey: client.sessionKey,
      exclusiveSession: 'true',
      sessionOwnerToken: OWNER_A,
    })).rejects.toMatchObject({
      status: 400,
      data: { code: 'invalid_exclusive_session' },
    });

    await expect(client.request('POST', '/tabs', {
      userId: client.userId,
      sessionKey: client.sessionKey,
      sessionOwnerToken: 'short',
    })).rejects.toMatchObject({
      status: 400,
      data: { code: 'invalid_session_owner_token' },
    });

    await expect(client.request('DELETE', `/sessions/${client.userId}`, {
      sessionOwnerToken: 'short',
    })).rejects.toMatchObject({
      status: 400,
      data: { code: 'invalid_session_owner_token' },
    });

    await expect(client.request(
      'GET',
      `/tabs?userId=${client.userId}&sessionOwnerToken=${OWNER_A}`,
    )).rejects.toMatchObject({
      status: 400,
      data: { code: 'invalid_session_owner_token' },
    });

    await expect(client.request('POST', '/tabs', {
      userId: client.userId,
      sessionKey: client.sessionKey,
      sessionOwnerToken: OWNER_A,
    }, {
      headers: { 'X-Camofox-Session-Owner': OWNER_B },
    })).rejects.toMatchObject({
      status: 400,
      data: { code: 'invalid_session_owner_token' },
    });

    await expect(client.request('POST', '/tabs', {
      userId: '__yt_transcript__',
      sessionKey: 'reserved-internal-session',
      exclusiveSession: true,
      sessionOwnerToken: OWNER_A,
    })).rejects.toMatchObject({
      status: 400,
      data: { code: 'reserved_session_user_id' },
    });
  });

  test('rejects missing identities on every user-scoped tab control', async () => {
    const client = createClient(serverUrl);
    for (const [method, path] of [
      ['GET', '/tabs'],
      ['POST', '/tabs/missing/wait'],
      ['POST', '/tabs/missing/type'],
      ['POST', '/tabs/missing/press'],
      ['POST', '/tabs/missing/scroll'],
      ['POST', '/tabs/missing/back'],
      ['POST', '/tabs/missing/forward'],
      ['POST', '/tabs/missing/refresh'],
      ['GET', '/tabs/missing/snapshot'],
      ['GET', '/tabs/missing/links'],
      ['GET', '/tabs/missing/downloads'],
      ['GET', '/tabs/missing/images'],
      ['GET', '/tabs/missing/screenshot'],
      ['GET', '/tabs/missing/stats'],
      ['POST', '/navigate'],
      ['GET', '/snapshot'],
      ['POST', '/act'],
    ]) {
      const body = method === 'GET' ? undefined : {};
      await expect(client.request(method, path, body)).rejects.toMatchObject({
        status: 400,
        data: { code: 'invalid_session_user_id' },
      });
    }
  });

  test('rejects malformed identities on GET /tabs', async () => {
    const client = createClient(serverUrl);
    for (const path of [
      '/tabs?userId=',
      '/tabs?userId=undefined',
      '/tabs?userId=null',
      '/tabs?userId=first&userId=second',
    ]) {
      await expect(client.request('GET', path)).rejects.toMatchObject({
        status: 400,
        data: { code: 'invalid_session_user_id' },
      });
    }
  });

  test('retains the operation lease after a client disconnects', async () => {
    const client = createClient(serverUrl);
    let claimed = false;
    try {
      const created = await client.request('POST', '/tabs', {
        userId: client.userId,
        sessionKey: 'disconnect-lease',
        url: `${testSiteUrl}/pageA`,
        exclusiveSession: true,
        sessionOwnerToken: OWNER_A,
      });
      claimed = true;

      await expect(client.request(
        'POST',
        `/tabs/${created.tabId}/evaluate`,
        {
          userId: client.userId,
          expression: 'new Promise(resolve => setTimeout(() => resolve("late-finish"), 400))',
        },
        {
          timeout: 100,
          headers: { 'X-Camofox-Session-Owner': OWNER_A },
        },
      )).rejects.toThrow('Request timeout');

      let deletionSettled = false;
      const deletion = client.request(
        'DELETE',
        `/sessions/${client.userId}`,
        null,
        { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
      ).then(result => {
        deletionSettled = true;
        return result;
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(deletionSettled).toBe(false);
      await expect(deletion).resolves.toMatchObject({ ok: true, claimReleased: true });
      claimed = false;
    } finally {
      if (claimed) {
        await client.request(
          'DELETE',
          `/sessions/${client.userId}`,
          null,
          { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
        ).catch(() => {});
      }
    }
  });

  test('excludes claimed sessions from global pressure cleanup', async () => {
    const client = createClient(serverUrl);
    let claimed = false;
    try {
      const created = await client.request('POST', '/tabs', {
        userId: client.userId,
        sessionKey: 'pressure-protected',
        url: `${testSiteUrl}/pageA`,
        exclusiveSession: true,
        sessionOwnerToken: OWNER_A,
      });
      claimed = true;
      const cleanup = await client.request('POST', '/pressure/cleanup', {
        dryRun: false,
        minIdleMs: 0,
        minTabsPerSession: 0,
        maxTabsToClose: 100,
        closeEmptySessions: true,
      });
      expect(cleanup.closed).toEqual([]);
      expect(cleanup.preserved.claimed).toBeGreaterThanOrEqual(1);
      await expect(client.request(
        'GET',
        `/tabs/${created.tabId}/snapshot?userId=${client.userId}`,
        null,
        { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
      )).resolves.toMatchObject({ url: `${testSiteUrl}/pageA` });
    } finally {
      if (claimed) {
        await client.request(
          'DELETE',
          `/sessions/${client.userId}`,
          null,
          { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
        ).catch(() => {});
      }
    }
  });

  test('clears a deletion reservation when its waiting client disconnects', async () => {
    const client = createClient(serverUrl);
    let claimed = false;
    try {
      const created = await client.request('POST', '/tabs', {
        userId: client.userId,
        sessionKey: 'disconnect-delete',
        url: `${testSiteUrl}/pageA`,
        exclusiveSession: true,
        sessionOwnerToken: OWNER_A,
      });
      claimed = true;
      const activeOperation = client.request(
        'POST',
        `/tabs/${created.tabId}/evaluate`,
        {
          userId: client.userId,
          expression: 'new Promise(resolve => setTimeout(() => resolve("operation-finished"), 400))',
        },
        { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
      );
      await new Promise(resolve => setTimeout(resolve, 50));

      await expect(client.request(
        'DELETE',
        `/sessions/${client.userId}`,
        null,
        {
          timeout: 100,
          headers: { 'X-Camofox-Session-Owner': OWNER_A },
        },
      )).rejects.toThrow('Request timeout');
      await expect(activeOperation).resolves.toMatchObject({ result: 'operation-finished' });

      await expect(client.request(
        'GET',
        `/tabs/${created.tabId}/snapshot?userId=${client.userId}`,
        null,
        { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
      )).resolves.toMatchObject({ url: `${testSiteUrl}/pageA` });
      await expect(client.request(
        'DELETE',
        `/sessions/${client.userId}`,
        null,
        { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
      )).resolves.toMatchObject({ ok: true, claimReleased: true });
      claimed = false;
    } finally {
      if (claimed) {
        await client.request(
          'DELETE',
          `/sessions/${client.userId}`,
          null,
          { headers: { 'X-Camofox-Session-Owner': OWNER_A } },
        ).catch(() => {});
      }
    }
  });

  test('allows exactly one winner for concurrent exclusive claims', async () => {
    const client = createClient(serverUrl);
    const bodies = [OWNER_A, OWNER_B].map((sessionOwnerToken) => ({
      userId: client.userId,
      sessionKey: client.sessionKey,
      exclusiveSession: true,
      sessionOwnerToken,
    }));

    const settled = await Promise.allSettled(
      bodies.map((body) => client.request('POST', '/tabs', body)),
    );
    const winners = settled
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === 'fulfilled');
    const losers = settled.filter((result) => result.status === 'rejected');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toMatchObject({
      status: 409,
      data: { code: 'session_ownership_conflict' },
    });

    const winningToken = bodies[winners[0].index].sessionOwnerToken;
    await client.request('DELETE', `/sessions/${client.userId}`, {
      sessionOwnerToken: winningToken,
    });
  }, 120000);
});
