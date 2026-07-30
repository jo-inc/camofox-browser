import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';

const ACCESS_KEY = 'access_0123456789abcdefghijklmnopqrstuvwxyz';

async function getCapabilities(serverUrl, token) {
  const response = await fetch(`${serverUrl}/capabilities`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'manual',
  });
  const body = await response.json();
  return { status: response.status, body };
}

describe('control capability readback', () => {
  let serverUrl;

  beforeAll(async () => {
    await startServer(0, { CAMOFOX_ACCESS_KEY: ACCESS_KEY });
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('proves access-key enforcement only after successful authentication', async () => {
    await expect(getCapabilities(serverUrl)).resolves.toMatchObject({ status: 401 });
    await expect(getCapabilities(serverUrl, `${ACCESS_KEY}x`)).resolves.toMatchObject({ status: 401 });

    const result = await getCapabilities(serverUrl, ACCESS_KEY);
    expect(result).toEqual({
      status: 200,
      body: {
        controlAccessKeyEnforced: true,
        atomicSessionOwnership: {
          version: 1,
          ownerTokenRetained: false,
          ownerTokenHeader: 'X-Camofox-Session-Owner',
        },
      },
    });
    expect(JSON.stringify(result.body)).not.toContain(ACCESS_KEY);
  });
});
