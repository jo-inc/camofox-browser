import fs from 'node:fs';
import path from 'node:path';

const serverSource = fs.readFileSync(path.resolve(process.cwd(), 'server.js'), 'utf8');

function gracefulShutdownSource() {
  const start = serverSource.indexOf('async function gracefulShutdown');
  const end = serverSource.indexOf("process.on('SIGTERM'", start);
  return serverSource.slice(start, end);
}

describe('shutdown budget', () => {
  test('gracefulShutdown arms its watchdog with the centralized CONFIG value', () => {
    const source = gracefulShutdownSource();

    expect(source).toMatch(/const forceTimeout = setTimeout\([\s\S]*?,\s*CONFIG\.shutdownTimeoutMs\);/);
    expect(source).not.toMatch(/},\s*10000\);/);
    expect(source).toMatch(/forceTimeout\.unref\(\);/);
  });
});