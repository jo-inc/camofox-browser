import {
  sanitizeFilename,
  guessMimeTypeFromName,
  clearTabDownloads,
  clearSessionDownloads,
  attachDownloadListener,
  clickWithDownloadGuard,
  downloadEventOccurredSince,
  getDownloadsList,
} from '../../lib/downloads.js';

import fs from 'node:fs/promises';
import os from 'os';
import path from 'path';

describe('lib/downloads', () => {
  describe('sanitizeFilename', () => {
    test('passes through normal filenames', () => {
      expect(sanitizeFilename('hello.txt')).toBe('hello.txt');
      expect(sanitizeFilename('photo.png')).toBe('photo.png');
    });

    test('replaces dangerous characters', () => {
      expect(sanitizeFilename('file/name:bad?.txt')).toBe('file_name_bad_.txt');
      expect(sanitizeFilename('a\\b<c>d|e"f')).toBe('a_b_c_d_e_f');
    });

    test('strips null bytes and control chars', () => {
      expect(sanitizeFilename('file\x00name\x01.txt')).toBe('file_name_.txt');
    });

    test('truncates to 200 chars', () => {
      const long = 'a'.repeat(250) + '.txt';
      expect(sanitizeFilename(long).length).toBe(200);
    });

    test('defaults to download.bin for empty/null', () => {
      expect(sanitizeFilename(null)).toBe('download.bin');
      expect(sanitizeFilename(undefined)).toBe('download.bin');
      expect(sanitizeFilename('')).toBe('download.bin');
    });
  });

  describe('guessMimeTypeFromName', () => {
    test('detects common image types', () => {
      expect(guessMimeTypeFromName('photo.png')).toBe('image/png');
      expect(guessMimeTypeFromName('photo.jpg')).toBe('image/jpeg');
      expect(guessMimeTypeFromName('photo.jpeg')).toBe('image/jpeg');
      expect(guessMimeTypeFromName('anim.gif')).toBe('image/gif');
      expect(guessMimeTypeFromName('pic.webp')).toBe('image/webp');
      expect(guessMimeTypeFromName('icon.svg')).toBe('image/svg+xml');
    });

    test('case insensitive', () => {
      expect(guessMimeTypeFromName('PHOTO.PNG')).toBe('image/png');
      expect(guessMimeTypeFromName('Photo.JPG')).toBe('image/jpeg');
    });

    test('falls back to octet-stream', () => {
      expect(guessMimeTypeFromName('data.bin')).toBe('application/octet-stream');
      expect(guessMimeTypeFromName('archive.zip')).toBe('application/octet-stream');
      expect(guessMimeTypeFromName(null)).toBe('application/octet-stream');
    });
  });

  describe('clearTabDownloads', () => {
    test('clears array and deletes temp files', async () => {
      const tmpFile = path.join(os.tmpdir(), `camofox-test-${Date.now()}.tmp`);
      await fs.writeFile(tmpFile, 'test');

      const tabState = {
        downloads: [
          { id: '1', filePath: tmpFile },
          { id: '2', filePath: null },
        ],
      };

      await clearTabDownloads(tabState);
      expect(tabState.downloads).toEqual([]);

      // file should be deleted
      await expect(fs.stat(tmpFile)).rejects.toThrow();
    });

    test('handles empty downloads gracefully', async () => {
      const tabState = { downloads: [] };
      await clearTabDownloads(tabState);
      expect(tabState.downloads).toEqual([]);
    });
  });

  describe('clearSessionDownloads', () => {
    test('clears downloads across all tab groups', async () => {
      const tab1 = { downloads: [{ id: '1', filePath: null }] };
      const tab2 = { downloads: [{ id: '2', filePath: null }] };
      const group = new Map([['t1', tab1], ['t2', tab2]]);
      const session = { tabGroups: new Map([['g1', group]]) };

      await clearSessionDownloads(session);
      expect(tab1.downloads).toEqual([]);
      expect(tab2.downloads).toEqual([]);
    });

    test('handles null/missing session gracefully', async () => {
      await clearSessionDownloads(null);
      await clearSessionDownloads({});
      await clearSessionDownloads({ tabGroups: null });
    });
  });

  describe('download events', () => {
    test('records the event before a slow save finishes', async () => {
      let handler;
      let releaseSave;
      const savePending = new Promise((resolve) => { releaseSave = resolve; });
      const tabState = {
        downloads: [],
        downloadEventSequence: 0,
        visitedUrls: new Set(),
        page: { on: (_event, callback) => { handler = callback; } },
      };
      const log = () => {};
      const download = {
        suggestedFilename: () => 'slow.txt',
        url: () => 'https://example.com/slow.txt',
        saveAs: async (filePath) => {
          await savePending;
          await fs.writeFile(filePath, 'done');
        },
        failure: async () => null,
      };

      attachDownloadListener(tabState, 'tab-1', log);
      const save = handler(download);

      expect(tabState.downloadEventSequence).toBe(1);
      expect(downloadEventOccurredSince(tabState, 0)).toBe(true);
      expect(tabState.downloads).toEqual([]);

      releaseSave();
      await save;
      await clearTabDownloads(tabState);
    });
  });

  describe('click fallback guard', () => {
    test('does not reject after a click emits a download event', async () => {
      const tabState = { downloadEventSequence: 0 };
      let calls = 0;
      const click = async () => {
        calls += 1;
        tabState.downloadEventSequence += 1;
        throw new Error('locator.click: Timeout 3000ms exceeded');
      };

      await expect(clickWithDownloadGuard(tabState, click)).resolves.toBeUndefined();
      expect(calls).toBe(1);
    });

    test('preserves click errors when no download event is emitted', async () => {
      const error = new Error('locator.click: Timeout 3000ms exceeded');

      await expect(clickWithDownloadGuard({ downloadEventSequence: 0 }, async () => {
        throw error;
      })).rejects.toBe(error);
    });
  });

  describe('getDownloadsList', () => {
    test('returns metadata without data by default', async () => {
      const tabState = {
        downloads: [{
          id: 'abc',
          url: 'https://example.com/file.png',
          suggestedFilename: 'file.png',
          mimeType: 'image/png',
          bytes: 1024,
          createdAt: '2026-01-01T00:00:00.000Z',
          filePath: '/tmp/nonexistent',
          failure: null,
        }],
      };

      const result = await getDownloadsList(tabState);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('abc');
      expect(result[0].suggestedFilename).toBe('file.png');
      expect(result[0].dataBase64).toBeUndefined();
      // filePath must not leak to response
      expect(result[0].filePath).toBeUndefined();
    });

    test('includes base64 data when includeData is true', async () => {
      const tmpFile = path.join(os.tmpdir(), `camofox-test-dl-${Date.now()}.tmp`);
      await fs.writeFile(tmpFile, 'hello world');

      const tabState = {
        downloads: [{
          id: 'x1',
          url: '',
          suggestedFilename: 'hello.txt',
          mimeType: 'application/octet-stream',
          bytes: 11,
          createdAt: '2026-01-01T00:00:00.000Z',
          filePath: tmpFile,
          failure: null,
        }],
      };

      const result = await getDownloadsList(tabState, { includeData: true });
      expect(result[0].dataBase64).toBe(Buffer.from('hello world').toString('base64'));

      await fs.unlink(tmpFile).catch(() => {});
    });

    test('skips data when bytes exceed maxBytes', async () => {
      const tabState = {
        downloads: [{
          id: 'big',
          url: '',
          suggestedFilename: 'big.bin',
          mimeType: 'application/octet-stream',
          bytes: 5000,
          createdAt: '2026-01-01T00:00:00.000Z',
          filePath: '/tmp/whatever',
          failure: null,
        }],
      };

      const result = await getDownloadsList(tabState, { includeData: true, maxBytes: 1000 });
      expect(result[0].dataSkipped).toBe('max_bytes_exceeded');
      expect(result[0].dataBase64).toBeUndefined();
    });

    test('reports readError when file is missing', async () => {
      const tabState = {
        downloads: [{
          id: 'gone',
          url: '',
          suggestedFilename: 'gone.txt',
          mimeType: 'application/octet-stream',
          bytes: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
          filePath: '/tmp/camofox-definitely-does-not-exist-xyz',
          failure: null,
        }],
      };

      const result = await getDownloadsList(tabState, { includeData: true });
      expect(result[0].readError).toBeDefined();
    });
  });
});
