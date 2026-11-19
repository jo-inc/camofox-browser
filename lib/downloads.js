/**
 * Download capture and DOM image extraction for camofox-browser.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import nodeFs, { constants as fsConstants } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const MAX_DOWNLOAD_RECORDS_PER_TAB = 20;
const MAX_DOWNLOAD_INLINE_BYTES = 20 * 1024 * 1024;
const MAX_DOWNLOAD_ARTIFACT_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TTL_MS = 15 * 60 * 1000;
const DOWNLOAD_ROOT = path.join(os.tmpdir(), 'camofox-downloads');
// Keep the fetch-current-resource limit aligned with persisted download artifacts.
const MAX_FETCHED_RESOURCE_BYTES = MAX_DOWNLOAD_ARTIFACT_BYTES;

function sanitizeFilename(value) {
  return String(value || 'download.bin')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .trim()
    .slice(0, 200) || 'download.bin';
}

function guessMimeTypeFromName(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.svg')) return 'image/svg+xml';
  if (normalized.endsWith('.pdf')) return 'application/pdf';
  if (normalized.endsWith('.json')) return 'application/json';
  if (normalized.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function artifactPath(downloadId) {
  return path.join(DOWNLOAD_ROOT, `${downloadId}.bin`);
}

async function removeDownloadFileIfPresent(record) {
  if (record?.filePath) await fs.unlink(record.filePath).catch(() => {});
}

async function trimTabDownloads(tabState) {
  while (tabState.downloads.length > MAX_DOWNLOAD_RECORDS_PER_TAB) {
    await removeDownloadFileIfPresent(tabState.downloads.shift());
  }
}

async function clearTabDownloads(tabState) {
  const entries = Array.isArray(tabState.downloads) ? [...tabState.downloads] : [];
  tabState.downloads = [];
  await Promise.all(entries.map(removeDownloadFileIfPresent));
}

async function clearSessionDownloads(session) {
  if (!session || !session.tabGroups) return;
  const tasks = [];
  for (const group of session.tabGroups.values()) {
    for (const tabState of group.values()) tasks.push(clearTabDownloads(tabState));
  }
  await Promise.all(tasks);
}

async function cleanupExpiredDownloads(tabState, now = Date.now()) {
  if (!Array.isArray(tabState?.downloads)) return;
  const retained = [];
  for (const record of tabState.downloads) {
    if (record.expiresAt && Date.parse(record.expiresAt) <= now) await removeDownloadFileIfPresent(record);
    else retained.push(record);
  }
  tabState.downloads = retained;
}

function downloadEventOccurredSince(tabState, sequence) {
  return (tabState.downloadEventSequence || 0) > sequence;
}

async function clickWithDownloadGuard(tabState, click) {
  const downloadSequence = tabState.downloadEventSequence || 0;
  try {
    return await click();
  } catch (err) {
    if (downloadEventOccurredSince(tabState, downloadSequence)) return;
    throw err;
  }
}

async function decodeBlobInPage(page, url, maxBytes) {
  // Keep the browser-side operation fixed and pass only a serialized data object.
  return page.evaluate(async ({ url: blobUrl, maxBytes: limit }) => {
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    if (blob.size > limit) throw new Error('download exceeds maximum artifact size');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error('download exceeds maximum artifact size');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { dataBase64: btoa(binary), mimeType: blob.type || 'application/octet-stream' };
  }, { url, maxBytes });
}

async function persistArtifact(downloadId, data) {
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
  if (raw.byteLength > MAX_DOWNLOAD_ARTIFACT_BYTES) throw new Error('download exceeds maximum artifact size');
  await fs.mkdir(DOWNLOAD_ROOT, { recursive: true, mode: 0o700 });
  const filePath = artifactPath(downloadId);
  await fs.writeFile(filePath, raw, { mode: 0o600, flag: 'wx' });
  await fs.chmod(filePath, 0o600);
  return { filePath, bytes: raw.byteLength, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

function attachDownloadListener(tabState, tabId, log, pluginEvents, userId) {
  if (tabState.downloadListenerAttached) return;
  tabState.downloadListenerAttached = true;

  tabState.page.on('download', async (download) => {
    tabState.downloadEventSequence = (tabState.downloadEventSequence || 0) + 1;
    const downloadId = crypto.randomUUID();
    const suggestedFilename = sanitizeFilename(download.suggestedFilename?.() || `download-${downloadId}.bin`);
    const url = String(download.url?.() || '').trim();
    const owner = String(userId || '');
    if (pluginEvents) pluginEvents.emit('tab:download:start', { userId: userId || null, tabId, filename: suggestedFilename, url });

    let failure = null;
    let persisted = null;
    let detectedMimeType = guessMimeTypeFromName(suggestedFilename);
    try {
      let raw;
      if (url.startsWith('blob:')) {
        const page = download.page?.() || tabState.page;
        const result = await decodeBlobInPage(page, url, MAX_DOWNLOAD_ARTIFACT_BYTES);
        detectedMimeType = result.mimeType || detectedMimeType;
        raw = Buffer.from(result.dataBase64, 'base64');
      } else {
        const stagingPath = path.join(DOWNLOAD_ROOT, `${downloadId}.staging`);
        await fs.mkdir(DOWNLOAD_ROOT, { recursive: true, mode: 0o700 });
        await download.saveAs(stagingPath);
        raw = await fs.readFile(stagingPath);
        await fs.unlink(stagingPath).catch(() => {});
      }
      persisted = await persistArtifact(downloadId, raw);
    } catch (err) {
      failure = String(err?.message || err || 'download_save_failed');
    }

    const reportedFailure = await download.failure().catch(() => null);
    if (reportedFailure) failure = reportedFailure;
    if (failure) await fs.unlink(artifactPath(downloadId)).catch(() => {});
    if (url) tabState.visitedUrls.add(url);
    const createdAt = new Date().toISOString();
    const record = {
      id: downloadId, downloadId, tabId, owner, url, filename: suggestedFilename,
      suggestedFilename, mimeType: detectedMimeType,
      bytes: persisted?.bytes ?? null, size: persisted?.bytes ?? null,
      sha256: persisted?.sha256 ?? null, createdAt,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_MS).toISOString(),
      filePath: failure ? null : persisted?.filePath ?? null, failure,
      state: failure ? 'failed' : 'completed',
    };
    tabState.downloads.push(record);
    if (pluginEvents && !failure) pluginEvents.emit('tab:download:complete', { userId: userId || null, tabId, filename: suggestedFilename, path: record.filePath, size: record.bytes });
    await trimTabDownloads(tabState);
    log('info', 'download captured', { tabId, downloadId, suggestedFilename, mimeType: record.mimeType, bytes: record.bytes, hasUrl: Boolean(url), failure });
  });
}

/**
 * Track the most recent main-frame navigation response for a tab so that a
 * resource the browser already received (for example a PDF rendered inline by
 * pdf.js after a JavaScript redirect or bot challenge) can be served without a
 * second fetch from Node. A Node-side refetch does not carry the browser's
 * TLS/JS fingerprint and is refused by some hosts (observed: PMC returns 403
 * HTML) even though the tab is displaying the PDF.
 */
function attachNavigationResponseTracker(tabState) {
  if (!tabState?.page?.on || tabState.navigationResponseTrackerAttached) return;
  tabState.navigationResponseTrackerAttached = true;
  tabState.lastMainFrameResponse = null;
  tabState.page.on('response', (response) => {
    try {
      const request = response.request();
      if (!request.isNavigationRequest()) return;
      const frame = typeof request.frame === 'function' ? request.frame() : null;
      const mainFrame = typeof tabState.page.mainFrame === 'function' ? tabState.page.mainFrame() : null;
      if (frame && mainFrame && frame !== mainFrame) return;
      tabState.lastMainFrameResponse = response;
    } catch {
      // request torn down; ignore
    }
  });
}

/**
 * Return { body, mimeType, headers, status } for the tab's current main-frame
 * response when it is a PDF the browser already holds and its URL matches the
 * requested one; null when unavailable, mismatched, or not a PDF.
 */
async function readInlinePdfResponse(tabState, url) {
  const response = tabState?.lastMainFrameResponse;
  if (!response) return null;
  try {
    if (String(response.url()) !== String(url)) return null;
    const headers = response.headers() || {};
    const mimeType = String(headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (mimeType !== 'application/pdf') return null;
    const declaredBytes = Number(headers['content-length']);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_FETCHED_RESOURCE_BYTES) {
      return { exceedsLimit: true };
    }
    const body = await response.body();
    if (!Buffer.isBuffer(body) || body.length === 0) return null;
    return { body, mimeType, headers, status: typeof response.status === 'function' ? response.status() : null };
  } catch {
    return null;
  }
}

async function captureFetchedResource(tabState, {
  url,
  mimeType,
  filename,
  body,
  userId,
  tabId = null,
}) {
  if (!Buffer.isBuffer(body)) throw new Error('Fetched resource body must be bytes');
  if (body.length > MAX_FETCHED_RESOURCE_BYTES) {
    throw new Error(`Fetched resource exceeds ${MAX_FETCHED_RESOURCE_BYTES} byte limit`);
  }

  const downloadId = crypto.randomUUID();
  const suggestedFilename = sanitizeFilename(filename || `resource-${downloadId}`);
  const persisted = await persistArtifact(downloadId, body);
  const createdAt = new Date().toISOString();
  const resolvedMimeType = mimeType || guessMimeTypeFromName(suggestedFilename);
  const record = {
    id: downloadId,
    downloadId,
    tabId,
    owner: String(userId || ''),
    url,
    filename: suggestedFilename,
    suggestedFilename,
    mimeType: resolvedMimeType,
    bytes: persisted.bytes,
    size: persisted.bytes,
    sha256: persisted.sha256,
    createdAt,
    expiresAt: new Date(Date.now() + DOWNLOAD_TTL_MS).toISOString(),
    filePath: persisted.filePath,
    failure: null,
    state: 'completed',
  };
  tabState.downloads.push(record);
  await trimTabDownloads(tabState);

  return {
    id: record.id,
    downloadId: record.downloadId,
    tabId: record.tabId,
    url: record.url,
    filename: record.filename,
    suggestedFilename: record.suggestedFilename,
    mimeType: record.mimeType,
    bytes: record.bytes,
    size: record.size,
    sha256: record.sha256,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    state: record.state,
  };
}

/**
 * Build the response array for GET /tabs/:tabId/downloads.
 */
async function getDownloadsList(tabState, { includeData = false, maxBytes = MAX_DOWNLOAD_INLINE_BYTES, downloadUrl } = {}) {
  await cleanupExpiredDownloads(tabState);
  const downloads = [];
  for (const entry of [...(tabState.downloads || [])]) {
    const item = {
      id: entry.id, downloadId: entry.downloadId || entry.id, url: entry.url,
      filename: entry.filename || entry.suggestedFilename, suggestedFilename: entry.suggestedFilename,
      state: entry.state || (entry.failure ? 'failed' : 'completed'), mimeType: entry.mimeType,
      bytes: entry.bytes, size: entry.size ?? entry.bytes, createdAt: entry.createdAt,
      sha256: entry.sha256 ?? null, failure: entry.failure,
      downloadUrl: downloadUrl ? downloadUrl(entry.id) : undefined,
    };
    if (!item.downloadUrl) delete item.downloadUrl;
    if (includeData && entry.filePath && !entry.failure) {
      if (typeof entry.bytes === 'number' && entry.bytes > maxBytes) item.dataSkipped = 'max_bytes_exceeded';
      else {
        try { item.dataBase64 = (await fs.readFile(entry.filePath)).toString('base64'); }
        catch (err) { item.readError = String(err?.message || err || 'download_read_failed'); }
      }
    }
    downloads.push(item);
  }
  return downloads;
}

function downloadRecordForOwner(tabState, downloadId, owner) {
  return (tabState.downloads || []).find((entry) => entry.id === downloadId && entry.owner === String(owner || ''));
}

function isSafeDownloadPath(record) {
  if (!record?.filePath || typeof record.filePath !== 'string') return false;
  const relative = path.relative(DOWNLOAD_ROOT, record.filePath);
  return Boolean(relative)
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
    && path.dirname(relative) === '.'
    && path.basename(record.filePath) === `${record.id}.bin`;
}

/**
 * Open a completed artifact once, then validate the opened descriptor. The
 * caller owns fileHandle and must close it.
 */
async function openDownloadContent(tabState, downloadId, owner) {
  await cleanupExpiredDownloads(tabState);
  const record = downloadRecordForOwner(tabState, downloadId, owner);
  if (!record || record.state !== 'completed' || !isSafeDownloadPath(record)) return null;

  let fileHandle;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
    fileHandle = await fs.open(record.filePath, flags);
    const stat = await fileHandle.stat();
    if (!stat.isFile() || stat.size > MAX_DOWNLOAD_ARTIFACT_BYTES) {
      await fileHandle.close();
      return null;
    }
    return { record, fileHandle, stat };
  } catch {
    await fileHandle?.close().catch(() => {});
    return null;
  }
}

/**
 * Backwards-compatible buffered reader for callers that import this helper.
 * The HTTP route uses sendDownloadContent() so response bodies are streamed.
 */
async function readDownloadContent(tabState, downloadId, owner) {
  const opened = await openDownloadContent(tabState, downloadId, owner);
  if (!opened) return null;
  try {
    return { record: opened.record, data: await opened.fileHandle.readFile() };
  } finally {
    await opened.fileHandle.close().catch(() => {});
  }
}

/** Parse one RFC 7233 byte range. Throws RangeError for any invalid range. */
function parseSingleByteRange(value, size) {
  if (value == null) return null;
  if (!Number.isSafeInteger(size) || size < 0 || typeof value !== 'string') throw new RangeError('Invalid byte range');

  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || value.includes(',') || (!match[1] && !match[2]) || size === 0) throw new RangeError('Invalid byte range');

  const fileSize = BigInt(size);
  if (!match[1]) {
    const suffixLength = BigInt(match[2]);
    if (suffixLength === 0n) throw new RangeError('Invalid byte range');
    const length = suffixLength < fileSize ? suffixLength : fileSize;
    return { start: Number(fileSize - length), end: size - 1, length: Number(length) };
  }

  const start = BigInt(match[1]);
  if (start >= fileSize) throw new RangeError('Invalid byte range');
  let end = match[2] ? BigInt(match[2]) : fileSize - 1n;
  if (end < start) throw new RangeError('Invalid byte range');
  if (end >= fileSize) end = fileSize - 1n;
  return { start: Number(start), end: Number(end), length: Number(end - start + 1n) };
}

function rfc5987Encode(value) {
  const wellFormed = String(value).toWellFormed();
  return encodeURIComponent(wellFormed).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function downloadContentDisposition(value) {
  const filename = sanitizeFilename(value).toWellFormed();
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download.bin';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

/**
 * Send an opened artifact through a descriptor-backed stream. This function
 * always closes the descriptor, including HEAD, invalid ranges, stream errors,
 * and client disconnects.
 */
async function sendDownloadContent(req, res, opened) {
  const { record, fileHandle, stat } = opened;
  let stream;
  try {
    let range;
    try {
      const rangeHeader = req.method === 'GET' && !req.get('if-range')
        ? req.get('range')
        : null;
      range = parseSingleByteRange(rangeHeader, stat.size);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      res.set({
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${stat.size}`,
        'Cache-Control': 'no-store',
      });
      res.status(416).end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, stat.size - 1);
    const length = range?.length ?? stat.size;
    res.status(range ? 206 : 200);
    res.set({
      'Content-Type': record.mimeType || 'application/octet-stream',
      'Content-Length': String(length),
      'Content-Disposition': downloadContentDisposition(record.filename || record.suggestedFilename),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    if (range) res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);

    if (req.method === 'HEAD' || length === 0) {
      res.end();
      return;
    }

    stream = nodeFs.createReadStream(record.filePath, {
      fd: fileHandle.fd,
      autoClose: false,
      start,
      end,
    });
    await pipeline(stream, res);
  } finally {
    stream?.destroy();
    await fileHandle.close().catch(() => {});
  }
}

export {
  MAX_DOWNLOAD_INLINE_BYTES,
  MAX_DOWNLOAD_ARTIFACT_BYTES,
  MAX_FETCHED_RESOURCE_BYTES,
  DOWNLOAD_ROOT,
  sanitizeFilename,
  guessMimeTypeFromName,
  clearTabDownloads,
  clearSessionDownloads,
  cleanupExpiredDownloads,
  attachDownloadListener,
  attachNavigationResponseTracker,
  readInlinePdfResponse,
  clickWithDownloadGuard,
  captureFetchedResource,
  downloadEventOccurredSince,
  getDownloadsList,
  readDownloadContent,
  openDownloadContent,
  parseSingleByteRange,
  downloadContentDisposition,
  sendDownloadContent,
};
