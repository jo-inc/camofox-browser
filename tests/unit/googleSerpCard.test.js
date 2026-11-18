import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { serpResultBlock, serpSnippet } from '../../lib/google-serp.js';

// Upstream has no DOM library, so a minimal element API (closest, querySelector, contains,
// textContent, parentElement) over the well-formed fixture HTML stands in for the page.
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: '\u00a0' };
const decode = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => (e[0] !== '#' ? NAMED[e] ?? m
  : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));

function matchesOne(el, sel) {
  const m = sel.match(/^([a-z][\w-]*)?((?:\.[\w-]+|\[[^\]]+\])*)$/i);
  if (!m) throw new Error(`unsupported selector: ${sel}`);
  if (m[1] && m[1].toLowerCase() !== el.tag) return false;
  for (const [, cls, attr] of m[2].matchAll(/\.([\w-]+)|\[([^\]]+)\]/g)) {
    if (cls) {
      if (!(el.attrs.class ?? '').split(/\s+/).includes(cls)) return false;
      continue;
    }
    const [, name, op, val] = attr.match(/^([\w-]+)(?:(\*?=)"([^"]*)")?$/);
    const v = el.attrs[name];
    if (v === undefined || (op === '=' && v !== val) || (op === '*=' && !v.includes(val))) return false;
  }
  return true;
}

class El {
  constructor(tag, attrs, parentElement) {
    Object.assign(this, { tag, attrs, parentElement, children: [] });
  }
  get textContent() { return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  *descendants() {
    for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.descendants(); }
  }
  matches(selectors) { return selectors.split(',').some((s) => matchesOne(this, s.trim())); }
  closest(selectors) {
    for (let el = this; el; el = el.parentElement) if (el.matches(selectors)) return el;
    return null;
  }
  querySelector(selectors) {
    for (const el of this.descendants()) if (el.matches(selectors)) return el;
    return null;
  }
  contains(other) {
    for (let el = other; el; el = el.parentElement) if (el === this) return true;
    return false;
  }
}

function parse(html) {
  const root = new El('#root', {}, null);
  let cur = root;
  for (const [, close, tag, attrs, text] of html.matchAll(/<(\/)?([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
    if (text !== undefined) cur.children.push(decode(text));
    else if (close) cur = cur.parentElement;
    else {
      const el = new El(tag.toLowerCase(), Object.fromEntries(
        [...attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [k, decode(v ?? '')])), cur);
      cur.children.push(el);
      if (!VOID.has(el.tag) && !attrs.endsWith('/')) cur = el;
    }
  }
  return root.children[0];
}

const fixture = JSON.parse(readFileSync(new URL('../fixtures/google-serp-cards-2026-11.json', import.meta.url), 'utf8'));
const firstResult = (card) => {
  const h3 = card.querySelector('h3');
  return { h3, link: h3.closest('a[href]') };
};

describe('Google SERP result card and snippet', () => {
  test.each(fixture.cards.map((html, i) => [i, html]))('captured card %i: the .MjjYud card is the block and its snippet is read', (i, html) => {
    const card = parse(html);
    const { h3, link } = firstResult(card);
    const block = serpResultBlock(h3, link, card);
    expect(block).toBe(card);
    expect(serpSnippet(block, h3)).toBe(fixture.snippets[i]);
  });

  test('one selector list stops at the header-only [data-snhf] div, whose text is the cite (the bug)', () => {
    const card = parse(fixture.cards[0]);
    const { h3 } = firstResult(card);
    const header = h3.closest('.MjjYud, .g, [data-snhf], [data-content-feature]');
    expect(header.attrs['data-snhf']).toBe('0');
    expect(serpSnippet(header, h3)).toMatch(/^Python documentationhttps:\/\/docs\.python\.org/);
  });

  test('falls back to [data-snhf], then the link\'s grandparent, when no card class is present', () => {
    const header = parse('<div><div data-snhf="0"><div><a href="https://example.com/"><h3>T</h3></a></div></div></div>');
    const { h3, link } = firstResult(header);
    expect(serpResultBlock(h3, link, header)).toBe(header.children[0]);
    const bare = parse('<div><div><span><a href="https://example.com/"><h3>T</h3></a></span></div></div>');
    const r = firstResult(bare);
    expect(serpResultBlock(r.h3, r.link, bare)).toBe(bare.children[0]);
  });

  test('an empty snippet element falls back to the text after the title', () => {
    const card = parse('<div class="MjjYud"><a href="https://example.com/"><h3>Title</h3></a><div data-sncf="1"> </div><span>A fallback description long enough to keep.</span></div>');
    const { h3 } = firstResult(card);
    expect(serpSnippet(card, h3)).toBe('A fallback description long enough to keep.');
  });
});
