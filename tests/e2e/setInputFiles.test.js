import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

jest.retryTimes(2, { logErrorsBeforeRetry: true });

describe('set_input_files', () => {
  let serverUrl;
  let testSiteUrl;
  let uploadsDir;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
    uploadsDir = env.uploadsDir;
  });

  test('attaches a file via selector and shows filename', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-resume.txt');
      fs.writeFileSync(filePath, 'dummy resume content');

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload`);

      const result = await client.setInputFiles(tabId, {
        selector: '#fileInput',
        files: [filePath],
      });

      expect(result.ok).toBe(true);
      expect(result.files).toEqual([filePath]);

      const snapshot = await client.waitForSnapshotContains(tabId, 'Selected: test-resume.txt');
      expect(snapshot.snapshot).toContain('Selected: test-resume.txt');
    } finally {
      await client.cleanup();
    }
  });

  test('attaches a file via ref and shows filename', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-cv.txt');
      fs.writeFileSync(filePath, 'dummy cv content');

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload`);

      const snapshot = await client.getSnapshot(tabId);
      const match = snapshot.snapshot.match(/\[(e\d+)\][^\n]*file/i);

      if (match) {
        const ref = match[1];
        const result = await client.setInputFiles(tabId, { ref, files: [filePath] });
        expect(result.ok).toBe(true);
      } else {
        const result = await client.setInputFiles(tabId, {
          selector: '#fileInput',
          files: [filePath],
        });
        expect(result.ok).toBe(true);
      }

      const updated = await client.waitForSnapshotContains(tabId, 'Selected: test-cv.txt');
      expect(updated.snapshot).toContain('Selected: test-cv.txt');
    } finally {
      await client.cleanup();
    }
  });

  test('rejects a path outside the uploads directory', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload`);

      await expect(
        client.setInputFiles(tabId, {
          selector: '#fileInput',
          files: ['/etc/passwd'],
        })
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await client.cleanup();
    }
  });

  test('rejects when neither ref nor selector is provided', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-noop.txt');
      fs.writeFileSync(filePath, 'content');

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload`);

      await expect(
        client.setInputFiles(tabId, { files: [filePath] })
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await client.cleanup();
    }
  });

  test('attaches a file to a custom dropzone via dropzoneSelector (file-chooser path)', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-dropzone.txt');
      fs.writeFileSync(filePath, 'dummy dropzone content');

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload-dropzone`);

      const result = await client.setInputFiles(tabId, {
        dropzoneSelector: '#dropzone',
        files: [filePath],
      });

      expect(result.ok).toBe(true);
      expect(result.via).toBe('filechooser');
      expect(result.files).toEqual([filePath]);

      const snapshot = await client.waitForSnapshotContains(tabId, 'Selected: test-dropzone.txt');
      expect(snapshot.snapshot).toContain('Selected: test-dropzone.txt');
    } finally {
      await client.cleanup();
    }
  });

  test('attaches a file to a custom dropzone via dropzoneRef (file-chooser path)', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-dropzone-ref.txt');
      fs.writeFileSync(filePath, 'dummy dropzone ref content');

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload-dropzone`);

      const snapshot = await client.getSnapshot(tabId);
      const match = snapshot.snapshot.match(/\[(e\d+)\][^\n]*click to browse/i);

      const result = match
        ? await client.setInputFiles(tabId, { dropzoneRef: match[1], files: [filePath] })
        : await client.setInputFiles(tabId, { dropzoneSelector: '#dropzone', files: [filePath] });

      expect(result.ok).toBe(true);
      expect(result.via).toBe('filechooser');

      const updated = await client.waitForSnapshotContains(tabId, 'Selected: test-dropzone-ref.txt');
      expect(updated.snapshot).toContain('Selected: test-dropzone-ref.txt');
    } finally {
      await client.cleanup();
    }
  });

  test('dropzone path still enforces the uploads-dir sandbox', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload-dropzone`);

      await expect(
        client.setInputFiles(tabId, {
          dropzoneSelector: '#dropzone',
          files: ['/etc/passwd'],
        })
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await client.cleanup();
    }
  });

  test('rejects with 400 when the dropzone target opens no file chooser', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-nochooser.txt');
      fs.writeFileSync(filePath, 'content');

      // Point the dropzone path at an element that does not open a chooser.
      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload-dropzone`);

      await expect(
        client.setInputFiles(tabId, {
          dropzoneSelector: '#fileName',
          files: [filePath],
        })
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await client.cleanup();
    }
  });

  test('reports via:input for the direct file-input path', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-via-input.txt');
      fs.writeFileSync(filePath, 'content');

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload`);

      const result = await client.setInputFiles(tabId, {
        selector: '#fileInput',
        files: [filePath],
      });

      expect(result.ok).toBe(true);
      expect(result.via).toBe('input');
    } finally {
      await client.cleanup();
    }
  });

  test('returns 404 for unknown tab', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-404.txt');
      fs.writeFileSync(filePath, 'content');

      await expect(
        client.setInputFiles('nonexistent-tab-id', {
          selector: '#fileInput',
          files: [filePath],
        })
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await client.cleanup();
    }
  });
});
