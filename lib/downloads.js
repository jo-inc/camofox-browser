/**
 * Download capture and DOM image extraction for camofox-browser.
 *
 * Handles Playwright download events, temp file lifecycle, and
 * in-page image source extraction with optional inline data.
 */

import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'node:fs/promises';

const MAX_DOWNLOAD_RECORDS_PER_TAB = 20;
const MAX_DOWNLOAD_INLINE_BYTES = 20 * 1024 * 1024;

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
  return 'application/octet-stream';
}

async function removeDownloadFileIfPresent(record) {
  const filePath = record?.filePath;
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => {});
}

async function trimTabDownloads(tabState) {
  while (tabState.downloads.length > MAX_DOWNLOAD_RECORDS_PER_TAB) {
    const stale = tabState.downloads.shift();
    await removeDownloadFileIfPresent(stale);
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
    for (const tabState of group.values()) {
      tasks.push(clearTabDownloads(tabState));
    }
  }
  await Promise.all(tasks);
}

function attachDownloadListener(tabState, tabId, log) {
  if (tabState.downloadListenerAttached) return;
  tabState.downloadListenerAttached = true;

  tabState.page.on('download', async (download) => {
    const downloadId = crypto.randomUUID();
    const suggestedFilename = sanitizeFilename(download.suggestedFilename?.() || `download-${downloadId}.bin`);
    const filePath = path.join(os.tmpdir(), `camofox-download-${downloadId}-${suggestedFilename}`);

    let failure = null;
    let bytes = null;

    try {
      await download.saveAs(filePath);
      const stat = await fs.stat(filePath);
      bytes = stat.size;
    } catch (err) {
      failure = String(err?.message || err || 'download_save_failed');
      await fs.unlink(filePath).catch(() => {});
    }

    const reportedFailure = await download.failure().catch(() => null);
    if (reportedFailure) {
      failure = reportedFailure;
    }

    const url = String(download.url?.() || '').trim();
    if (url) {
      tabState.visitedUrls.add(url);
    }

    const mimeType = guessMimeTypeFromName(suggestedFilename) || guessMimeTypeFromName(url);
    tabState.downloads.push({
      id: downloadId,
      tabId,
      url,
      suggestedFilename,
      mimeType,
      bytes,
      createdAt: new Date().toISOString(),
      filePath: failure ? null : filePath,
      failure,
    });

    await trimTabDownloads(tabState);
    log('info', 'download captured', {
      tabId, downloadId, suggestedFilename, mimeType, bytes,
      hasUrl: Boolean(url), failure,
    });
  });
}

/**
 * Build the response array for GET /tabs/:tabId/downloads.
 */
async function getDownloadsList(tabState, { includeData = false, maxBytes = MAX_DOWNLOAD_INLINE_BYTES } = {}) {
  const snapshot = Array.isArray(tabState.downloads) ? [...tabState.downloads] : [];
  const downloads = [];

  for (const entry of snapshot) {
    const item = {
      id: entry.id,
      url: entry.url,
      suggestedFilename: entry.suggestedFilename,
      mimeType: entry.mimeType,
      bytes: entry.bytes,
      createdAt: entry.createdAt,
      failure: entry.failure,
    };

    if (includeData && entry.filePath && !entry.failure) {
      if (typeof entry.bytes === 'number' && entry.bytes > maxBytes) {
        item.dataSkipped = 'max_bytes_exceeded';
      } else {
        try {
          const raw = await fs.readFile(entry.filePath);
          item.dataBase64 = raw.toString('base64');
        } catch (err) {
          item.readError = String(err?.message || err || 'download_read_failed');
        }
      }
    }

    downloads.push(item);
  }

  return downloads;
}

export {
  MAX_DOWNLOAD_INLINE_BYTES,
  sanitizeFilename,
  guessMimeTypeFromName,
  clearTabDownloads,
  clearSessionDownloads,
  attachDownloadListener,
  getDownloadsList,
};
