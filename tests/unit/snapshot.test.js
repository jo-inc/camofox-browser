const { windowSnapshot, MAX_SNAPSHOT_CHARS, SNAPSHOT_TAIL_CHARS } = require('../../lib/snapshot');

describe('windowSnapshot', () => {
  const CONTENT_BUDGET = MAX_SNAPSHOT_CHARS - SNAPSHOT_TAIL_CHARS - 200;

  test('small page passes through unchanged', () => {
    const yaml = '- heading "Hello World"\n- link "Home" [e1]\n';
    const result = windowSnapshot(yaml);
    expect(result.text).toBe(yaml);
    expect(result.truncated).toBe(false);
    expect(result.totalChars).toBe(yaml.length);
    expect(result.hasMore).toBeFalsy();
    expect(result.nextOffset).toBeFalsy();
  });

  test('empty input returns empty', () => {
    expect(windowSnapshot(null).text).toBe('');
    expect(windowSnapshot('').text).toBe('');
    expect(windowSnapshot(undefined).text).toBe('');
  });

  test('page exactly at limit passes through', () => {
    const yaml = 'X'.repeat(MAX_SNAPSHOT_CHARS);
    const result = windowSnapshot(yaml);
    expect(result.text).toBe(yaml);
    expect(result.truncated).toBe(false);
  });

  test('page 1 char over limit gets truncated', () => {
    const yaml = 'X'.repeat(MAX_SNAPSHOT_CHARS + 1);
    const result = windowSnapshot(yaml);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS + 200); // marker overhead
  });

  describe('large page truncation', () => {
    // Build a realistic snapshot: header + products + pagination footer
    const header = '- banner "Amazon"\n  - searchbox "Search" [e1]\n';
    const product = (i) => `- listitem "Product ${i}"\n  - link "Product ${i} Title" [e${i+10}]\n  - text "$${(9.99 + i).toFixed(2)}"\n  - text "★★★★☆"\n`;
    const pagination = '- navigation "Pagination"\n  - link "Previous" [e400]\n  - link "1" [e401]\n  - link "2" [e402]\n  - link "Next" [e403]\n';

    let bigYaml;
    beforeAll(() => {
      // ~200K chars
      let parts = [header];
      for (let i = 0; i < 2000; i++) parts.push(product(i));
      parts.push(pagination);
      bigYaml = parts.join('');
      expect(bigYaml.length).toBeGreaterThan(MAX_SNAPSHOT_CHARS * 2);
    });

    test('first chunk contains header', () => {
      const r = windowSnapshot(bigYaml, 0);
      expect(r.text).toContain('banner "Amazon"');
      expect(r.text).toContain('searchbox "Search"');
    });

    test('first chunk contains pagination tail', () => {
      const r = windowSnapshot(bigYaml, 0);
      expect(r.text).toContain('link "Next" [e403]');
      expect(r.text).toContain('link "Previous" [e400]');
    });

    test('first chunk has truncation marker with nextOffset', () => {
      const r = windowSnapshot(bigYaml, 0);
      expect(r.truncated).toBe(true);
      expect(r.hasMore).toBe(true);
      expect(r.nextOffset).toBeGreaterThan(0);
      expect(r.text).toContain('truncated at char');
      expect(r.text).toContain(`offset=${r.nextOffset}`);
    });

    test('second chunk starts where first left off', () => {
      const r1 = windowSnapshot(bigYaml, 0);
      const r2 = windowSnapshot(bigYaml, r1.nextOffset);
      expect(r2.offset).toBe(r1.nextOffset);
      // Second chunk content should be different from first
      const r1Content = r1.text.slice(0, 100);
      const r2Content = r2.text.slice(0, 100);
      expect(r2Content).not.toBe(r1Content);
    });

    test('second chunk also has pagination tail', () => {
      const r1 = windowSnapshot(bigYaml, 0);
      const r2 = windowSnapshot(bigYaml, r1.nextOffset);
      expect(r2.text).toContain('link "Next" [e403]');
    });

    test('iterating chunks covers full content', () => {
      let offset = 0;
      let chunks = 0;
      let seenProducts = new Set();

      while (true) {
        const r = windowSnapshot(bigYaml, offset);
        chunks++;

        // Extract product numbers from this chunk
        const matches = r.text.matchAll(/Product (\d+) Title/g);
        for (const m of matches) seenProducts.add(parseInt(m[1]));

        if (!r.hasMore) break;
        offset = r.nextOffset;
        if (chunks > 20) throw new Error('too many chunks — infinite loop?');
      }

      expect(chunks).toBeGreaterThan(1);
      // Should see products from near the start and near the end
      expect(seenProducts.has(0)).toBe(true);
      expect(seenProducts.has(1999)).toBe(true);
    });

    test('totalChars is consistent across chunks', () => {
      const r1 = windowSnapshot(bigYaml, 0);
      const r2 = windowSnapshot(bigYaml, r1.nextOffset);
      expect(r1.totalChars).toBe(bigYaml.length);
      expect(r2.totalChars).toBe(bigYaml.length);
    });
  });

  describe('offset edge cases', () => {
    const yaml = 'H'.repeat(100000) + 'T'.repeat(SNAPSHOT_TAIL_CHARS);

    test('negative offset clamps to 0', () => {
      const r = windowSnapshot(yaml, -1000);
      expect(r.offset).toBe(0);
    });

    test('offset beyond content clamps to safe value', () => {
      const r = windowSnapshot(yaml, yaml.length * 2);
      expect(r.offset).toBeLessThanOrEqual(yaml.length);
      expect(r.text.length).toBeGreaterThan(0);
    });

    test('offset at exact tail boundary', () => {
      const r = windowSnapshot(yaml, yaml.length - SNAPSHOT_TAIL_CHARS);
      expect(r.text.length).toBeGreaterThan(0);
      // Should contain the tail
      expect(r.text).toContain('T');
    });
  });

  describe('output size', () => {
    test('no chunk exceeds MAX_SNAPSHOT_CHARS + marker overhead', () => {
      const yaml = 'X'.repeat(300000);
      let offset = 0;
      while (true) {
        const r = windowSnapshot(yaml, offset);
        // Allow 500 chars overhead for the marker text
        expect(r.text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS + 500);
        if (!r.hasMore) break;
        offset = r.nextOffset;
      }
    });
  });
});
