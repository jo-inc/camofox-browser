import {
  MAX_MARKDOWN_CHARS,
  parseAriaSnapshot,
  renderAgentMarkdown,
  renderDocumentMarkdown,
  renderMarkdownFromAriaSnapshot,
  windowMarkdown,
} from '../../lib/markdown.js';

describe('deterministic aria snapshot markdown renderer', () => {
  function expectNoRefs(markdown) {
    expect(markdown).not.toContain('[ref=e');
    expect(markdown).not.toMatch(/\[e\d+\]/);
    expect(markdown).not.toContain('no ref');
    expect(markdown).not.toContain('[cursor=pointer]');
    expect(markdown).not.toContain('[nth=');
  }

  test('empty input returns empty Markdown', () => {
    expect(renderDocumentMarkdown('')).toBe('');
    expect(renderDocumentMarkdown(null)).toBe('');
    expect(renderAgentMarkdown(undefined)).toBe('');
  });

  test('renders common browser content shapes in document mode', () => {
    const raw = [
      '- heading "Quarterly results" [level=1]',
      '- paragraph "Revenue rose 12 percent year over year."',
      '- list:',
      '  - listitem "Europe revenue accelerated"',
      '- link "Investor presentation" [ref=e1]:',
      '  - /url: https://example.test/investors.pdf',
      '- button "Subscribe" [ref=e2] [disabled]',
      '- textbox "Search articles" [ref=e3]: value: "earnings"',
      '- img "CEO speaking at the annual meeting" [ref=e4]',
      '- table "Financial summary":',
      '  - row:',
      '    - columnheader "Metric"',
      '    - columnheader "Value"',
      '  - row:',
      '    - cell "Revenue"',
      '    - cell "€10M"',
      '- code "print(\\"ok\\")"',
    ].join('\n');

    const result = renderDocumentMarkdown(raw, { title: 'Results' });

    expect(result).toContain('# Quarterly results');
    expect(result).toContain('Revenue rose 12 percent year over year.');
    expect(result).toContain('- Europe revenue accelerated');
    expect(result).toContain('[Investor presentation](https://example.test/investors.pdf)');
    expect(result).toContain('![CEO speaking at the annual meeting]');
    expect(result).toContain('| Metric | Value |');
    expect(result).toContain('| Revenue | €10M |');
    expect(result).toContain('```\nprint("ok")\n```');
    expect(result).not.toContain('Subscribe');
    expect(result).not.toContain('Search articles');
    expectNoRefs(result);
  });

  test('prepends title only when no matching heading exists', () => {
    expect(renderDocumentMarkdown('- paragraph "Body."', { title: 'Article' })).toBe('# Article\n\nBody.');
    expect(renderDocumentMarkdown('- heading "Article" [level=1]\n- paragraph "Body."', { title: 'Article' }))
      .toBe('# Article\n\nBody.');
  });

  test('parses YAML-quoted role keys with colons', () => {
    const raw = [
      '- main:',
      '  - \'heading "feat(web): local Camofox #123" [level=1]\':',
      '  - paragraph "Body"',
    ].join('\n');

    expect(renderDocumentMarkdown(raw, { title: 'feat(web): local Camofox #123' }))
      .toBe('# feat(web): local Camofox #123\n\nBody');
  });

  test('parses nested aria snapshot indentation and slash properties', () => {
    const raw = [
      '- main:',
      '  - article "Story":',
      '    - heading "Title" [level=1]',
      '    - paragraph:',
      '      - text: "Hello "',
      '      - link "world":',
      '        - /url: /world',
      '  - paragraph "Sibling outside article"',
    ].join('\n');

    const root = parseAriaSnapshot(raw);
    const main = root.children[0];
    const article = main.children[0];
    const paragraph = article.children[1];
    const link = paragraph.children[1];

    expect(main.role).toBe('main');
    expect(article.role).toBe('article');
    expect(link.role).toBe('link');
    expect(link.props.url).toBe('/world');
    expect(main.children[1].label).toBe('Sibling outside article');
  });

  test('preserves anchor URLs and links without URLs while stripping refs', () => {
    const anchor = '- link "Contenu" [ref=e1]:\n  - /url: "#content"';
    const noUrl = '- link "Edition abonnés" [ref=e7]';

    expect(renderDocumentMarkdown(anchor)).toBe('[Contenu](#content)');
    expect(renderDocumentMarkdown(noUrl)).toBe('Edition abonnés');
  });

  test('strips ref/cursor/nth artifacts inside labels but preserves numeric citations', () => {
    const raw = [
      '- paragraph:',
      '  - text: "Hermes is mentioned in [1] and [12]. Read "',
      '  - link "[e247]Hermes [cursor=pointer]" [ref=e247] [nth=0]:',
      '    - /url: /wiki/Hermes',
      '  - text: " now."',
    ].join('\n');

    const result = renderDocumentMarkdown(raw);

    expect(result).toContain('[1]');
    expect(result).toContain('[12]');
    expect(result).toContain('[Hermes](/wiki/Hermes)');
    expectNoRefs(result);
  });

  test('document and agent share readable path but document omits refs and controls', () => {
    const raw = [
      '- paragraph:',
      '  - text: "Read "',
      '  - link "Docs" [ref=e1]:',
      '    - /url: /docs',
      '  - text: " now."',
      '- button "Subscribe" [ref=e2]',
      '- textbox "Email" [ref=e3]: value: "alice@example.test"',
    ].join('\n');

    expect(renderDocumentMarkdown(raw)).toBe('Read [Docs](/docs) now.');
    const agent = renderAgentMarkdown(raw);
    expect(agent).toContain('Read [Docs](/docs)[e1] now.');
    expect(agent).toContain('<button "Subscribe" [e2]>');
    expect(agent).toContain('<textbox "Email" [e3] value="alice@example.test">');
  });

  test('agent mode renders controls with refs, states, values, and no-ref markers', () => {
    const raw = [
      '- button "Save" [ref=e1] [disabled]',
      '- checkbox "I agree" [ref=e2] [checked]',
      '- switch "Email alerts" [ref=e3] [checked=false]',
      '- searchbox "Search" [ref=e4]: value: "browser"',
      '- button "Continue"',
    ].join('\n');

    const result = renderAgentMarkdown(raw);

    expect(result).toContain('<button "Save" [e1] disabled>');
    expect(result).toContain('<checkbox "I agree" [e2] checked>');
    expect(result).toContain('<switch "Email alerts" [e3] checked=false>');
    expect(result).toContain('<searchbox "Search" [e4] value="browser">');
    expect(result).toContain('<button "Continue" no ref>');
  });

  test('legacy @e refs normalize as refs but literal @e text in labels survives', () => {
    const raw = [
      '- link "Example @e42 should stay in label" @e1:',
      '  - /url: /example',
      '- paragraph "Literal @e99 text remains."',
    ].join('\n');

    const agent = renderAgentMarkdown(raw);
    expect(agent).toContain('[Example @e42 should stay in label](/example)[e1]');
    expect(agent).toContain('Literal @e99 text remains.');
    expect(renderDocumentMarkdown(raw)).toContain('Literal @e99 text remains.');
  });

  test('inline runs, inline code, and safe code fences render correctly', () => {
    const inline = [
      '- paragraph:',
      '  - text "Use "',
      '  - code "npm run `build`"',
      '  - text " now."',
    ].join('\n');
    const block = [
      '- pre:',
      '  - text "const fence = ```inside```;"',
    ].join('\n');

    expect(renderDocumentMarkdown(inline)).toBe('Use `` npm run `build` `` now.');
    expect(renderDocumentMarkdown(block)).toBe('````\nconst fence = ```inside```;\n````');
  });

  test('multiline pre blocks and deterministic line-number gutters render as code', () => {
    const raw = [
      '- pre:',
      '  - row:',
      '    - cell "1"',
      '    - cell "let value = 1;"',
      '  - row:',
      '    - cell "2"',
      '    - cell ""',
      '  - row:',
      '    - cell "3"',
      '    - cell "return value;"',
    ].join('\n');

    expect(renderDocumentMarkdown(raw)).toBe('```\nlet value = 1;\n\nreturn value;\n```');
  });

  test('headered tables render as Markdown tables and escape pipes', () => {
    const raw = [
      '- table "Scores":',
      '  - row:',
      '    - columnheader "Name"',
      '    - columnheader "Score"',
      '  - row:',
      '    - cell "A|B"',
      '    - cell "42"',
    ].join('\n');

    expect(renderDocumentMarkdown(raw)).toBe('**Scores**\n\n| Name | Score |\n| --- | --- |\n| A\\|B | 42 |');
  });

  test('labelled semantic tables can infer simple header rows', () => {
    const raw = [
      '- table "Market stats":',
      '  - row:',
      '    - cell "Metric"',
      '    - cell "Value"',
      '  - row:',
      '    - cell "Market cap"',
      '    - cell "$1.6T"',
      '  - row:',
      '    - cell "Volume"',
      '    - cell "$42.3B"',
    ].join('\n');

    expect(renderDocumentMarkdown(raw)).toBe('**Market stats**\n\n| Metric | Value |\n| --- | --- |\n| Market cap | $1.6T |\n| Volume | $42.3B |');
  });

  test('headerless layout tables flatten child-first instead of becoming pipe sludge', () => {
    const raw = [
      '- table:',
      '  - row "1. Story title 10 points":',
      '    - cell "1. Story title 10 points":',
      '      - row "1. Story title":',
      '        - cell "1.":',
      '          - text: "1."',
      '        - cell "Story title":',
      '          - link "Story title":',
      '            - /url: https://example.com/story',
      '      - row "10 points by alice":',
      '        - cell:',
      '          - text: "10 points by "',
      '          - link "alice":',
      '            - /url: user?id=alice',
    ].join('\n');

    const result = renderDocumentMarkdown(raw);
    expect(result).toContain('1. [Story title](https://example.com/story)');
    expect(result).toContain('10 points by [alice](user?id=alice)');
    expect(result).not.toContain('1. Story title 10 points');
    expect(result).not.toContain('| Story title |');
  });

  test('task list checkboxes render as GFM task lists; agent keeps control refs', () => {
    const raw = [
      '- list:',
      '  - listitem:',
      '    - checkbox "Done" [ref=e1] [checked]',
      '    - text "Ship renderer"',
      '  - listitem:',
      '    - checkbox "Todo" [ref=e2] [checked=false]',
      '    - text "Write tests"',
    ].join('\n');

    expect(renderDocumentMarkdown(raw)).toBe('- [x] Ship renderer\n- [ ] Write tests');
    const agent = renderAgentMarkdown(raw);
    expect(agent).toContain('- [x] Ship renderer <checkbox "Done" [e1] checked>');
    expect(agent).toContain('- [ ] Write tests <checkbox "Todo" [e2] checked=false>');
  });

  test('generated docs UI chrome is cleaned without dropping real prose', () => {
    const raw = [
      '- main:',
      '  - heading "InstallationDirect link to Installation" [level=2]',
      '  - button "Copy code to clipboard" [ref=e1]',
      '  - tablist:',
      '    - tab "npm" [ref=e2] [selected]',
      '    - tab "yarn" [ref=e3]',
      '  - pre:',
      '    - text: "npm install @playwright/test"',
      '  - paragraph "You can copy code examples into your editor."',
    ].join('\n');

    const result = renderDocumentMarkdown(raw);
    expect(result).toContain('## Installation');
    expect(result).toContain('npm install @playwright/test');
    expect(result).toContain('You can copy code examples into your editor.');
    expect(result).not.toContain('Direct link to Installation');
    expect(result).not.toContain('Copy code to clipboard');
    expect(result).not.toContain('npm yarn');
  });

  test('renderMarkdownFromAriaSnapshot dispatches by view', () => {
    const raw = '- link "Docs" [ref=e1]:\n  - /url: /docs';
    expect(renderMarkdownFromAriaSnapshot(raw, { view: 'document' })).toBe('[Docs](/docs)');
    expect(renderMarkdownFromAriaSnapshot(raw, { view: 'agent' })).toBe('[Docs](/docs)[e1]');
    expect(() => renderMarkdownFromAriaSnapshot(raw, { view: 'pretty' })).toThrow(/view/);
  });

  test('document mode drops javascript links while preserving content links', () => {
    const raw = [
      '- link "Run JS" [ref=e1]:',
      '  - /url: javascript:void(0)',
      '- link "Read" [ref=e2]:',
      '  - /url: /read',
    ].join('\n');

    expect(renderDocumentMarkdown(raw)).toBe('[Read](/read)');
    expect(renderAgentMarkdown(raw)).toContain('[Run JS](javascript:void(0))[e1]');
  });

  test('private-use glyph-only junk and duplicate adjacent lines are removed', () => {
    const raw = [
      '- paragraph "\uE001\uE002"',
      '- paragraph "Same line"',
      '- paragraph "Same line"',
    ].join('\n');

    expect(renderDocumentMarkdown(raw)).toBe('Same line');
  });
});

describe('windowMarkdown', () => {
  test('small Markdown passes through unchanged', () => {
    const markdown = '# Page\n\nBody';
    expect(windowMarkdown(markdown)).toEqual({
      text: markdown,
      truncated: false,
      totalChars: markdown.length,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
  });

  test('large Markdown is windowed with markdown-specific marker', () => {
    const markdown = 'A'.repeat(MAX_MARKDOWN_CHARS + 10000) + '\nTail link';
    const first = windowMarkdown(markdown, 0);

    expect(first.truncated).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(first.totalChars).toBe(markdown.length);
    expect(first.text).toContain('Call markdown with offset=');
    expect(first.text).not.toContain('Call snapshot with offset=');
    expect(first.text).toContain('Tail link');

    const second = windowMarkdown(markdown, first.nextOffset);
    expect(second.offset).toBe(first.nextOffset);
    expect(second.text.slice(0, 200)).not.toBe(first.text.slice(0, 200));
  });
});
