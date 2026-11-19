import fs, { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  DOWNLOAD_ROOT,
  MAX_DOWNLOAD_ARTIFACT_BYTES,
  downloadContentDisposition,
  openDownloadContent,
  parseSingleByteRange,
  sendDownloadContent,
} from '../../lib/downloads.js';

function artifact(id, overrides = {}) {
  return {
    id,
    owner: 'alice',
    state: 'completed',
    filePath: path.join(DOWNLOAD_ROOT, `${id}.bin`),
    filename: 'report.txt',
    mimeType: 'text/plain',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

class MockResponse extends Writable {
  constructor({ disconnect = false } = {}) {
    super();
    this.body = [];
    this.headers = new Map();
    this.statusCode = 200;
    this.headersSent = false;
    this.disconnect = disconnect;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  set(name, value) {
    if (typeof name === 'object') {
      for (const [key, entry] of Object.entries(name)) this.headers.set(key.toLowerCase(), String(entry));
    } else {
      this.headers.set(name.toLowerCase(), String(value));
    }
    return this;
  }

  get(name) {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  _write(chunk, _encoding, callback) {
    this.headersSent = true;
    if (this.disconnect) {
      this.disconnect = false;
      callback(new Error('client disconnected'));
      return;
    }
    this.body.push(Buffer.from(chunk));
    callback();
  }

  _final(callback) {
    this.headersSent = true;
    callback();
  }

  text() {
    return Buffer.concat(this.body).toString();
  }
}

function request(method = 'GET', range, headers = {}) {
  const values = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  if (range !== undefined) values.set('range', range);
  return {
    method,
    get: (name) => values.get(name.toLowerCase()),
  };
}

describe('download content streaming helpers', () => {
  const created = new Set();

  beforeAll(async () => {
    await fsp.mkdir(DOWNLOAD_ROOT, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    await Promise.all([...created].map((file) => fsp.rm(file, { force: true, recursive: true })));
    created.clear();
  });

  function track(file) {
    created.add(file);
    return file;
  }

  async function open(record) {
    return await openDownloadContent({ downloads: [record] }, record.id, 'alice');
  }

  test.each([
    ['bytes=0-3', 10, { start: 0, end: 3, length: 4 }],
    ['bytes=6-', 10, { start: 6, end: 9, length: 4 }],
    ['bytes=-3', 10, { start: 7, end: 9, length: 3 }],
    ['bytes=-99', 10, { start: 0, end: 9, length: 10 }],
    ['bytes=8-99', 10, { start: 8, end: 9, length: 2 }],
  ])('parses %s', (header, size, expected) => {
    expect(parseSingleByteRange(header, size)).toEqual(expected);
  });

  test.each([
    'bytes=10-20',
    'bytes=5-4',
    'bytes=0-1,4-5',
    'bytes=-0',
    'bytes=-',
    'items=0-1',
    'bytes= 0-1',
  ])('rejects invalid or unsatisfiable range %s', (header) => {
    expect(() => parseSingleByteRange(header, 10)).toThrow(RangeError);
  });

  test('builds an injection-safe RFC 5987 content disposition', () => {
    const value = downloadContentDisposition('résumé\r\n"report".txt');
    expect(value).toContain('filename="r_sum____report_.txt"');
    expect(value).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9___report_.txt");
    expect(value).not.toMatch(/[\r\n]/);
  });

  test('streams a full response from the already-open descriptor', async () => {
    const id = `stream-${process.pid}-${Date.now()}`;
    const record = artifact(id, { filename: 'résumé.txt' });
    await fsp.writeFile(track(record.filePath), '0123456789');
    const replacement = track(`${record.filePath}.replacement`);
    const opened = await open(record);
    await fsp.rename(record.filePath, replacement);
    created.delete(record.filePath);
    await fsp.writeFile(track(record.filePath), 'attacker!!');

    const response = new MockResponse();
    await sendDownloadContent(request(), response, opened);
    expect(response.statusCode).toBe(200);
    expect(response.text()).toBe('0123456789');
    expect(response.get('accept-ranges')).toBe('bytes');
    expect(response.get('content-length')).toBe('10');
    expect(response.get('cache-control')).toBe('no-store');
    expect(response.get('content-disposition')).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.txt");
    await expect(opened.fileHandle.stat()).rejects.toThrow();
  });

  test.each([
    ['bytes=0-3', '0123', 'bytes 0-3/10'],
    ['bytes=6-', '6789', 'bytes 6-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
  ])('serves one range: %s', async (range, body, contentRange) => {
    const record = artifact(`range-${process.pid}-${Math.random()}`);
    await fsp.writeFile(track(record.filePath), '0123456789');
    const opened = await open(record);
    const response = new MockResponse();
    await sendDownloadContent(request('GET', range), response, opened);
    expect(response.statusCode).toBe(206);
    expect(response.text()).toBe(body);
    expect(response.get('content-range')).toBe(contentRange);
    expect(response.get('content-length')).toBe(String(body.length));
    expect(response.get('accept-ranges')).toBe('bytes');
  });

  test.each(['bytes=99-', 'bytes=0-1,3-4', 'nonsense'])('returns 416 for %s', async (range) => {
    const record = artifact(`invalid-range-${process.pid}-${Math.random()}`);
    await fsp.writeFile(track(record.filePath), '0123456789');
    const opened = await open(record);
    const response = new MockResponse();
    await sendDownloadContent(request('GET', range), response, opened);
    expect(response.statusCode).toBe(416);
    expect(response.get('content-range')).toBe('bytes */10');
    expect(response.text()).toBe('');
    await expect(opened.fileHandle.stat()).rejects.toThrow();
  });

  test.each([undefined, 'bytes=2-5', 'nonsense'])('HEAD ignores Range and sends full headers with no body (range %s)', async (range) => {
    const record = artifact(`head-${process.pid}-${Math.random()}`);
    await fsp.writeFile(track(record.filePath), '0123456789');
    const response = new MockResponse();
    await sendDownloadContent(request('HEAD', range), response, await open(record));
    expect(response.statusCode).toBe(200);
    expect(response.get('content-length')).toBe('10');
    expect(response.get('content-range')).toBeNull();
    expect(response.text()).toBe('');
  });

  test('ignores Range when If-Range cannot be validated', async () => {
    const record = artifact(`if-range-${process.pid}-${Math.random()}`);
    await fsp.writeFile(track(record.filePath), '0123456789');
    const response = new MockResponse();
    await sendDownloadContent(request('GET', 'bytes=2-5', { 'if-range': '"stale-etag"' }), response, await open(record));
    expect(response.statusCode).toBe(200);
    expect(response.get('content-length')).toBe('10');
    expect(response.get('content-range')).toBeNull();
    expect(response.text()).toBe('0123456789');
  });

  test('rejects symlinks, non-regular files, and artifacts over the cap', async () => {
    const target = track(path.join(DOWNLOAD_ROOT, `target-${process.pid}-${Date.now()}`));
    await fsp.writeFile(target, 'target');

    const symlinkRecord = artifact(`symlink-${process.pid}-${Date.now()}`);
    track(symlinkRecord.filePath);
    await fsp.symlink(target, symlinkRecord.filePath);
    if (fsConstants.O_NOFOLLOW) await expect(open(symlinkRecord)).resolves.toBeNull();

    const directoryRecord = artifact(`directory-${process.pid}-${Date.now()}`);
    track(directoryRecord.filePath);
    await fsp.mkdir(directoryRecord.filePath);
    await expect(open(directoryRecord)).resolves.toBeNull();

    const oversizedRecord = artifact(`oversized-${process.pid}-${Date.now()}`);
    track(oversizedRecord.filePath);
    const handle = await fsp.open(oversizedRecord.filePath, 'w');
    await handle.truncate(MAX_DOWNLOAD_ARTIFACT_BYTES + 1);
    await handle.close();
    await expect(open(oversizedRecord)).resolves.toBeNull();
  });

  test('closes the descriptor when the client disconnects', async () => {
    const record = artifact(`disconnect-${process.pid}-${Date.now()}`);
    await fsp.writeFile(track(record.filePath), Buffer.alloc(1024 * 1024, 0x61));
    const opened = await open(record);
    const response = new MockResponse({ disconnect: true });
    await expect(sendDownloadContent(request(), response, opened)).rejects.toThrow('client disconnected');
    await expect(opened.fileHandle.stat()).rejects.toThrow();
  });
});
