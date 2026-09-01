import http from 'node:http';
import net from 'node:net';

const TEST_HOSTNAME = 'proxy-target.invalid';

function mappedHostname(hostname) {
  return hostname === TEST_HOSTNAME ? '127.0.0.1' : hostname;
}

export async function startFakeProxy(options = 0) {
  const config = options && typeof options === 'object' ? options : {};
  const preferredPort = typeof options === 'number' ? options : (config.preferredPort || 0);
  const expectedAuthorization = config.username !== undefined
    ? `Basic ${Buffer.from(`${config.username}:${config.password || ''}`).toString('base64')}`
    : null;
  const requests = [];
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end('invalid proxy request URL');
      return;
    }

    requests.push({
      method: req.method,
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      hadProxyAuthorization: Boolean(req.headers['proxy-authorization']),
    });

    if (expectedAuthorization && req.headers['proxy-authorization'] !== expectedAuthorization) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test-proxy"' });
      res.end('proxy authentication required');
      return;
    }

    const headers = { ...req.headers, host: target.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];

    const upstream = http.request({
      hostname: mappedHostname(target.hostname),
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });

    upstream.on('error', err => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`proxy upstream error: ${err.code || 'unknown'}`);
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    const separator = req.url.lastIndexOf(':');
    const hostname = separator === -1 ? req.url : req.url.slice(0, separator);
    const port = Number(separator === -1 ? 443 : req.url.slice(separator + 1));
    requests.push({
      method: 'CONNECT',
      hostname,
      path: '',
      hadProxyAuthorization: Boolean(req.headers['proxy-authorization']),
    });

    if (expectedAuthorization && req.headers['proxy-authorization'] !== expectedAuthorization) {
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
        'Proxy-Authenticate: Basic realm="test-proxy"\r\n' +
        'Content-Length: 0\r\n\r\n',
      );
      return;
    }

    const upstreamSocket = net.connect(port, mappedHostname(hostname), () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  return {
    port,
    server: `http://127.0.0.1:${port}`,
    requests,
    clearRequests() {
      requests.length = 0;
    },
    async stop() {
      await new Promise((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    },
  };
}

export function proxyTargetUrl(testSiteUrl, path = '/') {
  const url = new URL(testSiteUrl);
  url.hostname = TEST_HOSTNAME;
  url.pathname = path;
  return url.toString();
}
