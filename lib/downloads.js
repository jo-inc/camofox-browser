/**
 * Download capture and DOM image extraction for camofox-browser.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

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

async function readDownloadContent(tabState, downloadId, owner) {
  await cleanupExpiredDownloads(tabState);
  const record = (tabState.downloads || []).find((entry) => entry.id === downloadId && entry.owner === String(owner || ''));
  if (!record || record.state !== 'completed' || !record.filePath) return null;
  const relative = path.relative(DOWNLOAD_ROOT, record.filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.basename(record.filePath) !== `${record.id}.bin`) return null;
  try { return { record, data: await fs.readFile(record.filePath) }; } catch { return null; }
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
  clickWithDownloadGuard,
  captureFetchedResource,
  downloadEventOccurredSince,
  getDownloadsList,
  readDownloadContent,
};
