import { createClient } from '../helpers/client.js';
import { MAX_MARKDOWN_CHARS } from '../../lib/markdown.js';
import { getSharedEnv } from './sharedEnv.js';

describe('Markdown endpoint (e2e)', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  test('document view is the default and returns readable Markdown without refs or controls', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/markdown-fixture`);

      const result = await client.getMarkdown(tabId);

      expect(result.url).toContain('/markdown-fixture');
      expect(result.view).toBe('document');
      expect(typeof result.markdown).toBe('string');
      expect(result.markdown).toContain('# Release notes');
      expect(result.markdown).toContain('Read the [migration guide](/guide?keep=yes) before upgrading.');
      expect(result.markdown).toContain('- Build parser');
      expect(result.markdown).toContain('| Metric | Value |');
      expect(result.markdown).toContain('| Revenue | €10M |');
      expect(result.markdown).toContain('npm install @askjo/camofox-browser');
      expect(result.markdown).toContain('![Architecture diagram]');
      expect(result.markdown).not.toMatch(/\[e\d+\]/);
      expect(result.markdown).not.toContain('[ref=e');
      expect(result.markdown).not.toContain('<button');
      expect(result.markdown).not.toContain('<textbox');
      expect(result.refsCount).toBeGreaterThan(0);
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('agent view keeps actionable refs, control states, and refs work with existing click route', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/markdown-fixture`);

      const result = await client.getMarkdown(tabId, { view: 'agent' });

      expect(result.view).toBe('agent');
      expect(result.markdown).toContain('[migration guide](/guide?keep=yes)');
      expect(result.markdown).toMatch(/\[migration guide\]\(\/guide\?keep=yes\)\[e\d+\]/);
      expect(result.markdown).toMatch(/<button "Submit order" \[e\d+\]>/);
      expect(result.markdown).toMatch(/<(?:textbox|combobox) "Email" \[e\d+\] value="agent@example\.test">/);
      expect(result.markdown).not.toMatch(/<combobox "Country" \[e\d+\]/);
      expect(result.markdown).toMatch(/<combobox "Country" no ref/);

      const buttonRef = result.markdown.match(/<button "Submit order" \[(e\d+)\]>/)?.[1];
      expect(buttonRef).toBeTruthy();
      await client.click(tabId, { ref: buttonRef });
      const after = await client.getMarkdown(tabId);
      expect(after.markdown).toContain('Submit order clicked');
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('invalid view returns 400 and snapshot endpoint remains raw snapshot', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/markdown-fixture`);

      await expect(client.getMarkdown(tabId, { view: 'pretty' })).rejects.toMatchObject({ status: 400 });

      const snap = await client.getSnapshot(tabId);
      expect(snap.snapshot).toContain('heading');
      expect(snap.snapshot).toMatch(/\[e\d+\]/);
      expect(snap.snapshot).not.toContain('# Release notes');
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('large Markdown responses support offset pagination with Markdown marker', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/large-markdown-page?count=900`);
      const first = await client.getMarkdown(tabId, { view: 'document' });

      expect(first.truncated).toBe(true);
      expect(first.totalChars).toBeGreaterThan(MAX_MARKDOWN_CHARS);
      expect(first.markdown).toContain('Large Markdown Page');
      expect(first.markdown).toContain('Article 0');
      expect(first.markdown).toContain('[Next](/large-markdown-page?page=2)');
      expect(first.markdown).toContain('Call markdown with offset=');
      expect(first.markdown).not.toContain('Call snapshot with offset=');
      expect(first.hasMore).toBe(true);
      expect(first.nextOffset).toBeGreaterThan(0);

      const second = await client.getMarkdown(tabId, { view: 'document', offset: first.nextOffset });
      expect(second.truncated).toBe(true);
      expect(second.offset).toBe(first.nextOffset);
      expect(second.totalChars).toBe(first.totalChars);
      expect(second.markdown.slice(0, 200)).not.toBe(first.markdown.slice(0, 200));
      expect(second.markdown).toContain('[Next](/large-markdown-page?page=2)');
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('offset cache is scoped per view', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/large-markdown-page?count=900`);
      const documentFirst = await client.getMarkdown(tabId, { view: 'document' });
      const agentFirst = await client.getMarkdown(tabId, { view: 'agent' });

      expect(documentFirst.truncated).toBe(true);
      expect(agentFirst.truncated).toBe(true);
      const agentSecond = await client.getMarkdown(tabId, { view: 'agent', offset: agentFirst.nextOffset });
      expect(agentSecond.view).toBe('agent');
      expect(agentSecond.markdown).toMatch(/\[e\d+\]/);
      expect(agentSecond.totalChars).toBe(agentFirst.totalChars);
      expect(agentSecond.totalChars).not.toBe(documentFirst.totalChars);
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('markdown generation does not poison snapshot offset pagination', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/large-markdown-page?count=900`);
      const snapshotFirst = await client.getSnapshot(tabId);
      expect(snapshotFirst.truncated).toBe(true);
      expect(snapshotFirst.nextOffset).toBeGreaterThan(0);

      await client.getMarkdown(tabId, { view: 'agent' });
      const snapshotSecond = await client.getSnapshot(tabId, { offset: snapshotFirst.nextOffset });

      expect(snapshotSecond.totalChars).toBe(snapshotFirst.totalChars);
      expect(snapshotSecond.snapshot).toContain('Call snapshot with offset=');
      expect(snapshotSecond.snapshot).not.toContain('Call markdown with offset=');
      expect(snapshotSecond.snapshot).not.toContain('# Large Markdown Page');
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('navigation clears markdown offset cache before serving continuation requests', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/large-markdown-page?count=900`);
      const first = await client.getMarkdown(tabId, { view: 'document' });
      expect(first.truncated).toBe(true);
      expect(first.nextOffset).toBeGreaterThan(0);

      await client.navigate(tabId, `${testSiteUrl}/pageA`);
      const afterNavigate = await client.getMarkdown(tabId, { view: 'document', offset: first.nextOffset });

      expect(afterNavigate.url).toContain('/pageA');
      expect(afterNavigate.markdown).toContain('Page A');
      expect(afterNavigate.markdown).not.toContain('Large Markdown Page');
      expect(afterNavigate.markdown).not.toContain('Article 0');
      expect(afterNavigate.offset).toBe(0);
    } finally {
      await client.cleanup();
    }
  }, 120000);
});
