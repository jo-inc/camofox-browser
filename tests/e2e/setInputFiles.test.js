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
      // The dropzone carries role=button, so it must appear in the snapshot —
      // fail loudly rather than silently falling back to the selector path,
      // which would leave dropzoneRef resolution untested.
      const dropLine = snapshot.snapshot.split('\n').find(l => /drop file|click to browse/i.test(l));
      expect(dropLine).toBeTruthy();
      const refMatch = dropLine.match(/\[(e\d+)\]/);
      expect(refMatch).toBeTruthy();

      const result = await client.setInputFiles(tabId, { dropzoneRef: refMatch[1], files: [filePath] });

      expect(result.ok).toBe(true);
      expect(result.via).toBe('filechooser');

      const updated = await client.waitForSnapshotContains(tabId, 'Selected: test-dropzone-ref.txt');
      expect(updated.snapshot).toContain('Selected: test-dropzone-ref.txt');
    } finally {
      await client.cleanup();
    }
  });

  test('rejects a symlink inside the uploads dir that points outside it', async () => {
    const client = createClient(serverUrl);

    try {
      // A symlink planted in the uploads dir must not smuggle an out-of-tree
      // target (e.g. /etc/passwd) past the containment check.
      const link = path.join(uploadsDir, 'escape.txt');
      try { fs.unlinkSync(link); } catch { /* not present */ }
      fs.symlinkSync('/etc/passwd', link);

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload`);

      await expect(
        client.setInputFiles(tabId, { selector: '#fileInput', files: [link] })
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      try { fs.unlinkSync(path.join(uploadsDir, 'escape.txt')); } catch { /* ignore */ }
      await client.cleanup();
    }
  });

  test('rejects a directory path even inside the uploads dir', async () => {
    const client = createClient(serverUrl);

    try {
      const dir = path.join(uploadsDir, 'a-directory');
      fs.mkdirSync(dir, { recursive: true });

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload`);

      await expect(
        client.setInputFiles(tabId, { selector: '#fileInput', files: [dir] })
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await client.cleanup();
    }
  });

  test('rejects when userId is missing', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-nouser.txt');
      fs.writeFileSync(filePath, 'content');

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload`);

      await expect(
        client.setInputFiles(tabId, { userId: undefined, selector: '#fileInput', files: [filePath] })
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await client.cleanup();
    }
  });

  test('dropzone target takes precedence when both a direct and dropzone target are given', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-precedence.txt');
      fs.writeFileSync(filePath, 'content');

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload-dropzone`);

      // Supply both a valid direct input selector and the dropzone selector.
      const result = await client.setInputFiles(tabId, {
        selector: '#hiddenInput',
        dropzoneSelector: '#dropzone',
        files: [filePath],
      });

      expect(result.ok).toBe(true);
      expect(result.via).toBe('filechooser');
    } finally {
      await client.cleanup();
    }
  });

  test('direct setInputFiles on a non-input dropzone div fails (justifies the dropzone path)', async () => {
    const client = createClient(serverUrl);

    try {
      const filePath = path.join(uploadsDir, 'test-divfail.txt');
      fs.writeFileSync(filePath, 'content');

      const { tabId } = await client.createTab(`${testSiteUrl}/file-upload-dropzone`);

      // Targeting the visible div directly (not via the dropzone path) cannot
      // work — it isn't an <input type=file>. This is why dropzoneSelector exists.
      await expect(
        client.setInputFiles(tabId, { selector: '#dropzone', files: [filePath] })
      ).rejects.toThrow();
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
