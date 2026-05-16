/**
 * Deterministic Playwright ariaSnapshot(mode='ai') -> Markdown renderer.
 *
 * This module intentionally renders browser-native accessibility snapshot facts.
 * It does not infer page state, fabricate refs, or call an LLM. Document mode is
 * readable Markdown without action refs; agent mode keeps refs, control states,
 * and values inline for automation.
 */

const MAX_MARKDOWN_CHARS = 80000;
const MARKDOWN_TAIL_CHARS = 5000;

const CONTROL_ROLES = new Set([
  'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem',
  'slider', 'spinbutton', 'progressbar', 'scrollbar', 'separator',
]);

const STRUCTURAL_SKIP_ROLES = new Set(['menu', 'menubar', 'tablist', 'listbox']);
const CHROME_ROLES = new Set(['banner', 'navigation', 'toolbar', 'menu', 'menubar', 'contentinfo', 'search', 'form']);
const PRIMARY_READABLE_ROLES = new Set(['main', 'article']);
const SECONDARY_READABLE_ROLES = new Set(['section', 'region', 'document', 'group']);
const LATE_CHROME_ROLES = new Set(['banner', 'navigation', 'search', 'form', 'complementary', 'toolbar', 'menu', 'menubar']);
const LOW_VALUE_DOCUMENT_ACTION_LINKS = new Set(['upvote', 'hide', 'fork', 'star', 'watch', 'subscribe', 'sign in', 'login']);
const TRACKING_QUERY_KEYS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid']);
const KNOWN_ARIA_ROLES = new Set([
  'fragment', 'page', 'document', 'application', 'main', 'article', 'region', 'section', 'group',
  'generic', 'none', 'presentation', 'banner', 'navigation', 'contentinfo', 'complementary',
  'toolbar', 'menu', 'menubar', 'tablist', 'tabpanel', 'dialog', 'alertdialog', 'search', 'form',
  'feed', 'log', 'marquee', 'math', 'timer', 'tooltip', 'heading', 'paragraph', 'text', 'caption',
  'status', 'alert', 'note', 'time', 'blockquote', 'figure', 'list', 'listitem', 'link', 'img',
  'image', 'iframe', 'table', 'grid', 'tree', 'treegrid', 'treeitem', 'row', 'rowgroup', 'cell',
  'gridcell', 'columnheader', 'rowheader', 'code', 'pre', 'strong', 'emphasis', 'em', 'italic',
  'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'radiogroup', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'listbox', 'slider',
  'spinbutton', 'meter', 'progressbar', 'scrollbar', 'separator', 'term', 'definition',
  'deletion', 'insertion', 'subscript', 'superscript',
]);

class AriaNode {
  constructor(role, label = '', { ref = null, states = [], indent = -1, raw = '', value = '', level = null } = {}) {
    this.role = role;
    this.label = label || '';
    this.ref = ref;
    this.states = states.filter(Boolean);
    this.indent = indent;
    this.raw = raw;
    this.value = value || '';
    this.level = level;
    this.children = [];
    this.props = {};
    this.meta = {};
    this.text = '';
  }
}

function normalizeWs(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function parseQuotedName(rest) {
  const source = String(rest ?? '');
  if (!source.startsWith('"')) return ['', source.trim()];
  let label = '';
  let escaped = false;
  for (let i = 1; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      if (ch === 'n') label += '\n';
      else if (ch === 't') label += '\t';
      else label += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      return [label, source.slice(i + 1).trim()];
    }
    label += ch;
  }
  return [label, ''];
}

function parseRegexName(rest) {
  const source = String(rest ?? '');
  if (!source.startsWith('/')) return ['', source.trim()];
  let escaped = false;
  for (let i = 1; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '/') {
      return [source.slice(0, i + 1), source.slice(i + 1).trim()];
    }
  }
  return [source, ''];
}

function splitUnquotedColon(content) {
  const source = String(content ?? '');
  let quote = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && source[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':') {
      return [source.slice(0, i).trim(), source.slice(i + 1).trim()];
    }
  }
  return [source.trim(), ''];
}

function unquoteYamlScalar(value) {
  const raw = String(value ?? '').trim();
  if (raw.length >= 2 && raw[0] === '"' && raw.at(-1) === '"') {
    return parseQuotedName(raw)[0];
  }
  if (raw.length >= 2 && raw[0] === "'" && raw.at(-1) === "'") {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function unquoteAriaSnapshotKey(key) {
  return unquoteYamlScalar(key);
}

function unquoteAccessibleName(value) {
  return unquoteYamlScalar(value);
}

function parseRefToken(token) {
  const trimmed = String(token ?? '').trim();
  if (/^@e\d+$/.test(trimmed)) return `[${trimmed.slice(1)}]`;
  if (/^e\d+$/.test(trimmed)) return `[${trimmed}]`;
  const match = /^ref=(e\d+)$/.exec(trimmed);
  if (match) return `[${match[1]}]`;
  return null;
}

function parseAriaRoleKey(key, { indent = -1, raw = '', value = '' } = {}) {
  const source = String(key ?? '').trim();
  if (!source) return null;
  const roleMatch = /^([a-zA-Z][\w-]*)(.*)$/.exec(source);
  if (!roleMatch) return null;
  const role = roleMatch[1].toLowerCase();
  let rest = roleMatch[2].trim();
  let label = '';

  if (rest.startsWith('"')) {
    if (role === 'code' || role === 'pre') {
      const end = rest.lastIndexOf('"');
      if (end > 0) {
        label = rest.slice(1, end).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        rest = rest.slice(end + 1).trim();
      } else {
        [label, rest] = parseQuotedName(rest);
      }
    } else {
      [label, rest] = parseQuotedName(rest);
    }
  } else if (rest.startsWith('/')) {
    [label, rest] = parseRegexName(rest);
  }

  let ref = null;
  let level = null;
  const states = [];

  const atRefMatch = /(?:^|\s)@(e\d+)(?=\s|:|$)/.exec(rest);
  if (atRefMatch) {
    ref = `[${atRefMatch[1]}]`;
    rest = `${rest.slice(0, atRefMatch.index)} ${rest.slice(atRefMatch.index + atRefMatch[0].length)}`.trim();
  }

  for (const match of rest.matchAll(/\[([^\]]+)\]/g)) {
    const token = match[1].trim();
    const parsedRef = parseRefToken(token);
    if (parsedRef) {
      ref = parsedRef;
      continue;
    }
    if (token.startsWith('level=')) {
      const parsed = Number.parseInt(token.slice('level='.length), 10);
      if (Number.isFinite(parsed)) level = parsed;
      else states.push(token);
      continue;
    }
    states.push(token);
  }

  const restWithoutAttrs = rest.replace(/\[[^\]]+\]/g, '').trim();
  if (restWithoutAttrs && label) {
    states.push(restWithoutAttrs.replace(/^:/, '').trim());
  }

  return new AriaNode(role, normalizeWs(label), { ref, states, indent, raw, value: unquoteAccessibleName(value), level });
}

function ariaTailLooksValid(tail) {
  const source = String(tail ?? '').trim();
  if (!source) return true;
  if (source.startsWith(':')) return true;
  const bracketless = source.replace(/\[[^\]]+\]/g, '').trim();
  if (!bracketless || bracketless.startsWith(':')) return true;
  if (/(?<!\S)@e\d+(?=\s|:|$)/.test(source)) {
    const remainder = bracketless.replace(/(?<!\S)@e\d+(?=\s|:|$)/g, '').trim();
    return !remainder || remainder.startsWith(':');
  }
  return false;
}

function looksLikeAriaSnapshotContent(content) {
  let source = String(content ?? '').trim();
  if (!source) return false;
  if (source.startsWith('/')) return true;
  source = unquoteAriaSnapshotKey(source.endsWith(':') ? source.slice(0, -1).trim() : source);
  const roleMatch = /^([a-zA-Z][\w-]*)(.*)$/.exec(source);
  if (!roleMatch) return false;
  const role = roleMatch[1].toLowerCase();
  const rest = roleMatch[2].trim();
  const hasBrowserMarker = /\[(?:ref=)?(?:f\d+)?e\d+\]|\[e\d+\]/.test(rest)
    || /\[(?:level|checked|disabled|selected|expanded|pressed|cursor|nth)=/.test(rest)
    || /(?<!\S)@e\d+(?=\s|:|$)/.test(rest);
  if (!KNOWN_ARIA_ROLES.has(role) && !hasBrowserMarker) return false;
  if (!rest) return true;
  if (/\[(?:ref=)?e\d+\]/.test(rest)) return true;
  if (rest.startsWith(':')) return true;
  if (rest.startsWith('"')) {
    if (role === 'code' || role === 'pre') {
      const end = rest.lastIndexOf('"');
      if (end > 0) return ariaTailLooksValid(rest.slice(end + 1));
    }
    const [, tail] = parseQuotedName(rest);
    return ariaTailLooksValid(tail);
  }
  if (rest.startsWith('/')) {
    const [, tail] = parseRegexName(rest);
    return ariaTailLooksValid(tail);
  }
  if (rest.startsWith('[')) return ariaTailLooksValid(rest);
  return /(?<!\S)@e\d+(?=\s|:|$)/.test(rest) || /\[(?:ref=)?e\d+\]/.test(rest);
}

function parseAriaSnapshot(snapshotText, { assumeAriaSnapshot = false } = {}) {
  const root = new AriaNode('fragment');
  const stack = [root];

  for (const rawLine of String(snapshotText ?? '').split('\n')) {
    if (!rawLine.trim()) continue;
    const stripped = rawLine.trimStart();
    const indent = rawLine.length - stripped.length;
    let content;
    if (stripped.startsWith('- ')) {
      content = stripped.slice(2).trim();
      if (!assumeAriaSnapshot && !looksLikeAriaSnapshotContent(content)) continue;
    } else {
      content = stripped.trim();
      if (!assumeAriaSnapshot && !looksLikeAriaSnapshotContent(content)) continue;
    }
    if (!content) continue;

    let [key, value] = splitUnquotedColon(content);
    key = unquoteAriaSnapshotKey(key);

    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1);

    if (key === 'text') {
      const node = new AriaNode('text', '', { indent, raw: rawLine, value });
      node.text = unquoteAccessibleName(value);
      parent.children.push(node);
      continue;
    }
    if (key.startsWith('/')) {
      parent.props[key.slice(1)] = unquoteAccessibleName(value);
      continue;
    }

    const node = parseAriaRoleKey(key, { indent, raw: rawLine, value });
    if (!node) continue;
    if (!node.label) {
      let tail = key.replace(new RegExp(`^${node.role}\\s*`, 'i'), '').trim();
      tail = tail.replace(/\[[^\]]+\]/g, '').trim();
      tail = tail.replace(/(?<!\S)@e\d+(?!\S)/g, '').trim();
      if (tail) node.label = normalizeWs(tail);
    }
    parent.children.push(node);
    if (value) {
      const textNode = new AriaNode('text', '', { indent: indent + 2, raw: rawLine, value });
      textNode.text = unquoteAccessibleName(value);
      node.children.push(textNode);
    }
    stack.push(node);
  }

  return root;
}

function stripBrowserRefAnnotations(text) {
  let cleaned = String(text ?? '');
  cleaned = cleaned.replace(/\s*\[(?:ref=)?(?:f\d+)?e\d+\]\s*/g, ' ');
  cleaned = cleaned.replace(/\s*\[nth=\d+\]\s*/g, ' ');
  cleaned = cleaned.replace(/\s*\[cursor=pointer\]\s*/g, ' ');
  cleaned = cleaned.replace(/(["'“‘])\s+/g, '$1');
  cleaned = cleaned.replace(/\s+(["'”’])/g, '$1');
  return normalizeWs(cleaned);
}

function nodeText(node) {
  if (!node) return '';
  if (node.role === 'text') {
    return normalizeWs(stripBrowserRefAnnotations(unquoteAccessibleName(node.text || node.value || node.label)));
  }
  if (node.label) return normalizeWs(stripBrowserRefAnnotations(node.label));
  const parts = [];
  for (const child of node.children) {
    const text = nodeText(child);
    if (text) parts.push(text);
  }
  return normalizeWs(stripBrowserRefAnnotations(parts.join(' ')));
}

function isPrivateUseSymbolJunk(text) {
  const compact = [...String(text ?? '')].filter(ch => !/\s/.test(ch));
  if (!compact.length) return false;
  return compact.every(ch => {
    const code = ch.codePointAt(0);
    return (code >= 0xe000 && code <= 0xf8ff)
      || (code >= 0xf0000 && code <= 0xffffd)
      || (code >= 0x100000 && code <= 0x10fffd);
  });
}

function cleanGeneratedDocUiText(text) {
  let cleaned = stripBrowserRefAnnotations(text);
  if (!cleaned || isPrivateUseSymbolJunk(cleaned)) return '';
  cleaned = cleaned.replace(/\s+Copy code to clipboard\s*$/i, '').trim();
  let match = /^(?<head>.+?)\s*Direct link to\s+(?<target>.+)$/i.exec(cleaned);
  if (match) {
    const head = normalizeWs(match.groups.head);
    const target = normalizeWs(match.groups.target);
    if (head && target && head.toLocaleLowerCase() === target.toLocaleLowerCase()) return head;
  }
  match = /^(?<head>.+?)\s*Link for\s+(?<target>.+)$/i.exec(cleaned);
  if (match) {
    const head = normalizeWs(match.groups.head);
    const target = normalizeWs(match.groups.target);
    if (head && target && head.toLocaleLowerCase() === target.toLocaleLowerCase()) return head;
  }
  return cleaned;
}

function cleanGeneratedHeadingText(text) {
  const cleaned = cleanGeneratedDocUiText(text);
  if (!cleaned) return '';
  const match = /^(?<head>.+?)\s*Go to\s+(?<target>[a-z0-9][a-z0-9-]{1,80})$/i.exec(cleaned);
  if (match) {
    const head = normalizeWs(match.groups.head);
    const target = normalizeWs(match.groups.target).toLocaleLowerCase();
    const slug = head.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (head && target && (slug === target || slug.split('-').includes(target))) return head;
  }
  return cleaned;
}

function isGeneratedDocUiLabel(text) {
  return normalizeWs(text).toLocaleLowerCase() === 'copy code to clipboard';
}

function cleanGeneratedDocCodeLine(text) {
  return String(text ?? '')
    .replace(/\s*\[(?:ref=)?e\d+\]\s*/g, ' ')
    .replace(/\s*\[nth=\d+\]\s*/g, ' ')
    .replace(/\s*\[cursor=pointer\]\s*/g, ' ')
    .replace(/\s+Copy code to clipboard\s*$/i, '')
    .replace(/[ \t]+$/g, '');
}

function isControlRole(role) {
  return CONTROL_ROLES.has(role);
}

function isStructuralSkipRole(role) {
  return STRUCTURAL_SKIP_ROLES.has(role);
}

function isLowValueDocumentActionLink(node) {
  return node.role === 'link' && LOW_VALUE_DOCUMENT_ACTION_LINKS.has(normalizeWs(cleanGeneratedDocUiText(nodeText(node))).toLocaleLowerCase());
}

function isSkipLink(node) {
  if (node.role !== 'link') return false;
  const label = normalizeWs(cleanGeneratedDocUiText(nodeText(node))).toLocaleLowerCase();
  const href = normalizeWs(node.props.url || '');
  return label.startsWith('skip to') && href.startsWith('#');
}

function isJavascriptHref(href) {
  return normalizeWs(href).toLocaleLowerCase().startsWith('javascript:');
}

function escapeMdText(text) {
  const source = String(text ?? '');
  if (!source) return source;
  if (source[0] === '#' || source[0] === '>') return `\\${source}`;
  if (source.startsWith('- ') || source.startsWith('* ') || source.startsWith('+ ')) return `\\${source}`;
  if (/^\d+[.)]\s/.test(source)) return `\\${source}`;
  if (['---', '***', '___'].includes(source)) return `\\${source}`;
  return source;
}

function escapeMdBlockText(text) {
  const escaped = escapeMdText(text);
  if (escaped === String(text ?? '') && String(text ?? '').startsWith('|')) return `\\${text ?? ''}`;
  return escaped;
}

function escapeMdLinkLabel(text) {
  return normalizeWs(text).replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function maxBacktickRun(text) {
  const matches = String(text ?? '').match(/`+/g) || [];
  return matches.reduce((max, run) => Math.max(max, run.length), 0);
}

function inlineCodeMarkdown(text) {
  const source = String(text ?? '');
  if (!source) return '';
  const run = maxBacktickRun(source);
  const ticks = '`'.repeat(Math.max(1, run + 1));
  return run ? `${ticks} ${source} ${ticks}` : `${ticks}${source}${ticks}`;
}

function codeFenceFor(text) {
  return '`'.repeat(Math.max(3, maxBacktickRun(text) + 1));
}

function codeLanguageLabel(node) {
  const label = normalizeWs(stripBrowserRefAnnotations(node.label || ''));
  if (!label) return '';
  const match = /^(?:(?:language|lang)-)?([A-Za-z0-9_+.#-]{1,32})$/.exec(label);
  if (!match) return '';
  return match[1].replace(/^[._-]+|[._-]+$/g, '').toLocaleLowerCase();
}

function markdownFenceToken(line) {
  const match = /^\s*(`{3,})(?:[A-Za-z0-9_+.#-]+)?\s*$/.exec(String(line ?? ''));
  return match ? match[1] : '';
}

function sanitizeDisplayHref(href) {
  const raw = String(href ?? '');
  if (!raw || !raw.includes('?')) return raw;
  try {
    const url = new URL(raw, 'http://camofox.invalid');
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLocaleLowerCase();
      if (lower.startsWith('utm_') || TRACKING_QUERY_KEYS.has(lower)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (!changed) return raw;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return url.toString();
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path || raw;
  } catch {
    return raw;
  }
}

function ensureOptions(options = {}) {
  return {
    emitRefs: Boolean(options.emitRefs),
    emitControls: Boolean(options.emitControls),
    readableOrder: options.readableOrder !== false,
    compactChrome: options.compactChrome !== false,
  };
}

function nodeRefToken(node, { emitRefs } = {}) {
  if (!emitRefs) return '';
  return node.ref || 'no ref';
}

function agentRefSuffix(node, options) {
  if (!options.emitRefs) return '';
  return node.ref || ' no ref';
}

function quoteControlAttr(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function controlValueForMarkdown(node) {
  let value = cleanGeneratedDocUiText(node.value || '');
  if (value.toLocaleLowerCase().startsWith('value:')) {
    value = unquoteAccessibleName(value.split(':').slice(1).join(':').trim());
  }
  return [Boolean(value), value];
}

function controlMarkdown(node, options) {
  if (!options.emitControls) return '';
  const label = cleanGeneratedDocUiText(nodeText(node));
  const quoted = label ? `"${quoteControlAttr(label)}"` : '(unlabeled)';
  const ref = nodeRefToken(node, { emitRefs: true }) || 'no ref';
  const parts = [node.role, quoted, ref];
  const [hasValue, value] = controlValueForMarkdown(node);
  if (hasValue) parts.push(`value="${quoteControlAttr(value)}"`);
  parts.push(...node.states.map(state => String(state).trim()).filter(Boolean));
  return `<${parts.join(' ')}>`;
}

function formatInlineSpacing(parts) {
  let result = '';
  const noSpaceBefore = new Set('.,;:!?)]}…'.split(''));
  const noSpaceAfter = new Set('([{¿¡'.split(''));
  for (const raw of parts) {
    const part = normalizeWs(raw);
    if (!part) continue;
    if (!result) {
      result = part;
    } else if (noSpaceBefore.has(part[0]) || noSpaceAfter.has(result.at(-1))) {
      result += part;
    } else {
      result += ` ${part}`;
    }
  }
  return result.trim();
}

function inlineMarkdown(node, options = {}) {
  const opts = ensureOptions(options);
  const role = node.role;
  if (isControlRole(role)) return controlMarkdown(node, opts);
  if (isStructuralSkipRole(role)) return '';
  if (role === 'text') {
    const text = cleanGeneratedDocUiText(nodeText(node));
    return isGeneratedDocUiLabel(text) ? '' : escapeMdText(text);
  }
  if (role === 'link') {
    if (isSkipLink(node)) return '';
    if (!opts.emitRefs && isLowValueDocumentActionLink(node)) return '';
    const label = cleanGeneratedDocUiText(nodeText(node));
    if (!label) return '';
    const href = node.props.url;
    if (href && isJavascriptHref(href) && !opts.emitRefs) return '';
    const refSuffix = agentRefSuffix(node, opts);
    if (href) return `[${escapeMdLinkLabel(label)}](${sanitizeDisplayHref(href)})${refSuffix}`;
    return `${escapeMdText(label)}${refSuffix}`;
  }
  if (role === 'strong') {
    if (node.children.length) return formatInlineSpacing(node.children.map(child => inlineMarkdown(child, opts)));
    const text = cleanGeneratedDocUiText(nodeText(node));
    return text ? `**${text}**` : '';
  }
  if (['emphasis', 'em', 'italic'].includes(role)) {
    if (node.children.length) return formatInlineSpacing(node.children.map(child => inlineMarkdown(child, opts)));
    const text = cleanGeneratedDocUiText(nodeText(node));
    return text ? `*${text}*` : '';
  }
  if (role === 'code') {
    const text = cleanGeneratedDocUiText(nodeText(node));
    return text ? inlineCodeMarkdown(text) : '';
  }
  if (role === 'deletion') {
    const text = node.children.length ? formatInlineSpacing(node.children.map(child => inlineMarkdown(child, opts))) : cleanGeneratedDocUiText(nodeText(node));
    return text ? `~~${escapeMdText(text)}~~` : '';
  }
  if (['insertion', 'subscript', 'superscript'].includes(role)) {
    const text = node.children.length ? formatInlineSpacing(node.children.map(child => inlineMarkdown(child, opts))) : cleanGeneratedDocUiText(nodeText(node));
    return escapeMdText(text);
  }
  if (['paragraph', 'generic', 'none', 'presentation', 'group', 'cell', 'gridcell', 'columnheader', 'rowheader'].includes(role)) {
    if (node.children.length) return formatInlineSpacing(node.children.map(child => inlineMarkdown(child, opts)));
    return escapeMdText(cleanGeneratedDocUiText(nodeText(node)));
  }
  return escapeMdText(cleanGeneratedDocUiText(nodeText(node)));
}

function appendLine(out, line) {
  const value = String(line ?? '').replace(/[ \t]+$/g, '');
  if (!value) return;
  if (out.length && normalizeWs(out.at(-1)).toLocaleLowerCase() === normalizeWs(value).toLocaleLowerCase()) return;
  out.push(value);
}

function appendBlank(out) {
  if (out.length && out.at(-1) !== '') out.push('');
}

function appendBlock(out, lines, { trailingBlank = true } = {}) {
  const blockLines = Array.isArray(lines) ? [...lines] : [String(lines ?? '')];
  const cleaned = blockLines.map(line => String(line ?? '').replace(/[ \t]+$/g, ''));
  while (cleaned.length && !cleaned[0]) cleaned.shift();
  while (cleaned.length && !cleaned.at(-1)) cleaned.pop();
  if (!cleaned.length) return;
  appendBlank(out);
  for (const line of cleaned) {
    if (line) appendLine(out, line);
    else appendBlank(out);
  }
  if (trailingBlank) appendBlank(out);
}

function normalizeRenderedLines(lines) {
  const normalized = [];
  let previousBlank = false;
  let lastNonblank = '';
  for (const raw of lines) {
    const line = String(raw ?? '').replace(/[ \t]+$/g, '');
    if (!line) {
      if (normalized.length && !previousBlank) normalized.push('');
      previousBlank = true;
      continue;
    }
    const normalizedLine = normalizeWs(line).toLocaleLowerCase();
    if (lastNonblank && lastNonblank === normalizedLine) {
      if (previousBlank && normalized.at(-1) === '') normalized.pop();
      previousBlank = false;
      continue;
    }
    normalized.push(line);
    lastNonblank = normalizedLine;
    previousBlank = false;
  }
  while (normalized.length && !normalized[0]) normalized.shift();
  while (normalized.length && !normalized.at(-1)) normalized.pop();
  return normalized;
}

function* walkAriaNodes(node) {
  yield node;
  for (const child of node.children) yield* walkAriaNodes(child);
}

function annotateListMetadata(root) {
  function visit(node, depth = 0) {
    if (node.role === 'list') {
      for (const child of node.children) {
        if (child.role === 'listitem') {
          child.meta.listDepth = depth;
          child.meta.isWrapperListitem = !child.children.some(grand => grand.role !== 'list');
          child.meta.listPrefix = '-';
          visit(child, depth + 1);
        } else {
          visit(child, depth);
        }
      }
      return;
    }
    for (const child of node.children) visit(child, depth);
  }
  visit(root);
}

function tableRows(node) {
  const rows = [];
  for (const child of node.children) {
    if (child.role === 'row') rows.push(child);
    else if (child.role === 'rowgroup') rows.push(...child.children.filter(grand => grand.role === 'row'));
  }
  return rows;
}

function rowCells(row) {
  return row.children.filter(child => ['cell', 'gridcell', 'columnheader', 'rowheader'].includes(child.role));
}

function hasExplicitTableHeader(node) {
  return tableRows(node).some(row => rowCells(row).some(cell => ['columnheader', 'rowheader'].includes(cell.role)));
}

function annotateTableMetadata(root) {
  for (const node of walkAriaNodes(root)) {
    if (['table', 'grid', 'treegrid'].includes(node.role)) node.meta.hasExplicitHeader = hasExplicitTableHeader(node);
  }
}

function annotateCodeMetadata(root) {
  for (const node of walkAriaNodes(root)) {
    if (['code', 'pre'].includes(node.role)) node.meta.language = codeLanguageLabel(node);
  }
}

function prepareA11yMarkdownTree(root) {
  annotateListMetadata(root);
  annotateTableMetadata(root);
  annotateCodeMetadata(root);
  return root;
}

function nodeHasDescendantRole(node, roles) {
  return roles.has(node.role) || node.children.some(child => nodeHasDescendantRole(child, roles));
}

function hasSubstantiveBlockContent(node) {
  if (['main', 'article', 'paragraph', 'blockquote', 'table', 'grid', 'treegrid', 'code', 'pre'].includes(node.role)) return true;
  if (node.role === 'heading' && cleanGeneratedDocUiText(nodeText(node))) return true;
  if (node.role === 'listitem') {
    const text = cleanGeneratedDocUiText(nodeText(node));
    if (text.length > 80 || node.children.some(child => ['paragraph', 'code', 'pre', 'table', 'grid', 'treegrid'].includes(child.role))) return true;
  }
  return node.children.some(hasSubstantiveBlockContent);
}

function readableOrderCategory(node) {
  if (PRIMARY_READABLE_ROLES.has(node.role)) return 0;
  if (SECONDARY_READABLE_ROLES.has(node.role)) return 1;
  if (LATE_CHROME_ROLES.has(node.role)) return 2;
  if (node.role === 'contentinfo') return 3;
  return 1;
}

function orderedReadableChildren(children, options) {
  if (!options.readableOrder) return children;
  const hasPrimary = children.some(child => nodeHasDescendantRole(child, PRIMARY_READABLE_ROLES));
  const hasContentLike = children.some(child => !LATE_CHROME_ROLES.has(child.role) && child.role !== 'contentinfo' && hasSubstantiveBlockContent(child));
  const hasChromeLike = children.some(child => LATE_CHROME_ROLES.has(child.role) || child.role === 'contentinfo');
  if (!hasPrimary && !(hasContentLike && hasChromeLike)) return children;
  return children.map((child, index) => ({ child, index }))
    .sort((a, b) => readableOrderCategory(a.child) - readableOrderCategory(b.child) || a.index - b.index)
    .map(item => item.child);
}

function chromeTitle(node) {
  if (node.role === 'banner') return 'Header';
  if (node.role === 'contentinfo') return 'Footer';
  if (['menu', 'menubar', 'toolbar'].includes(node.role)) return 'Navigation';
  if (node.role === 'search') return 'Search';
  if (node.role === 'form') return 'Form';
  return node.role === 'navigation' ? 'Navigation' : node.role.replace(/-/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function compactItemNodes(node) {
  if (node.role === 'link' || isControlRole(node.role)) return [node];
  return node.children.flatMap(compactItemNodes);
}

function compactableChromeNode(node, options) {
  if (!options.compactChrome || !CHROME_ROLES.has(node.role)) return false;
  const items = compactItemNodes(node).filter(item => inlineMarkdown(item, options));
  if (!items.length) return false;
  if (hasSubstantiveBlockContent(node)) return false;
  if (['search', 'form'].includes(node.role)) return items.length >= 2;
  return items.length >= 2 || ['navigation', 'contentinfo'].includes(node.role);
}

function renderCompactChromeNode(node, out, options) {
  if (!compactableChromeNode(node, options)) return false;
  const items = [];
  const seen = new Set();
  for (const item of compactItemNodes(node)) {
    const rendered = inlineMarkdown(item, options);
    if (!rendered) continue;
    const key = normalizeWs(rendered).toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(rendered);
  }
  if (!items.length) return false;
  const renderedItems = !options.emitRefs && items.length > 8 ? [...items.slice(0, 6), `… ${items.length - 6} more`] : items;
  appendBlock(out, [`## ${chromeTitle(node)}`, `- ${renderedItems.join(', ')}`]);
  return true;
}

function isConsentNode(node) {
  if (!['dialog', 'alertdialog'].includes(node.role)) return false;
  const text = normalizeWs(nodeText(node)).toLocaleLowerCase();
  if (!['cookie', 'consent', 'privacy', 'legitimate interest'].some(term => text.includes(term))) return false;
  const controls = compactItemNodes(node)
    .filter(child => isControlRole(child.role))
    .map(child => cleanGeneratedDocUiText(nodeText(child)).toLocaleLowerCase());
  return controls.some(label => ['accept', 'reject', 'manage', 'choices', 'options'].some(term => label.includes(term)));
}

function renderConsentNode(node, out, options) {
  if (!isConsentNode(node)) return false;
  const textParts = [];
  const controls = [];
  function walk(current) {
    if (isControlRole(current.role)) {
      const rendered = controlMarkdown(current, options);
      if (rendered) controls.push(rendered);
      return;
    }
    if (['heading', 'paragraph', 'text', 'caption', 'status', 'alert', 'note'].includes(current.role)) {
      const text = current.children.length ? inlineMarkdown(current, options) : cleanGeneratedDocUiText(nodeText(current));
      if (text && !isGeneratedDocUiLabel(text)) textParts.push(text);
      return;
    }
    for (const child of current.children) walk(child);
  }
  walk(node);
  const lines = ['## Consent'];
  const compact = [...new Set(textParts.map(part => normalizeWs(part)).filter(Boolean))].join(' — ');
  if (compact) lines.push(compact);
  if (options.emitControls) lines.push(...new Set(controls));
  appendBlock(out, lines);
  return true;
}

function isInlineFragmentRole(role, options = {}) {
  const opts = ensureOptions(options);
  return ['text', 'link', 'strong', 'emphasis', 'em', 'italic', 'deletion', 'insertion', 'subscript', 'superscript'].includes(role)
    || (opts.emitControls && isControlRole(role));
}

function checkboxChecked(node) {
  const states = new Set(node.states.map(state => String(state).trim().toLocaleLowerCase()).filter(Boolean));
  if (states.has('checked=false') || states.has('checked: false') || states.has('unchecked')) return false;
  return states.has('checked') || states.has('checked=true') || states.has('checked: true');
}

function taskListitemParts(node, options) {
  const checkbox = node.children.find(child => child.role === 'checkbox');
  if (!checkbox) return null;
  const textChildren = node.children.filter(child => child !== checkbox && child.role !== 'list');
  let text = formatInlineSpacing(textChildren.map(child => inlineMarkdown(child, options)));
  if (!text && node.label) text = escapeMdText(cleanGeneratedDocUiText(nodeText(node)));
  if (!text) return null;
  const marker = checkboxChecked(checkbox) ? '[x]' : '[ ]';
  const control = controlMarkdown(checkbox, options);
  return [marker, text, control];
}

function renderTermDefinitionPair(term, definition, options) {
  const termText = term.children.length ? inlineMarkdown(term, options) : escapeMdText(cleanGeneratedDocUiText(nodeText(term)));
  const definitionText = definition.children.length ? inlineMarkdown(definition, options) : escapeMdText(cleanGeneratedDocUiText(nodeText(definition)));
  if (!termText || !definitionText) return '';
  return `**${termText.replace(/:$/g, '')}:** ${definitionText}`;
}

function renderDocumentChildren(children, out, { listDepth = 0, options = {} } = {}) {
  const opts = ensureOptions(options);
  const pendingInline = [];
  function flushInline() {
    if (pendingInline.length) {
      appendBlock(out, formatInlineSpacing(pendingInline));
      pendingInline.length = 0;
    }
  }

  let idx = 0;
  while (idx < children.length) {
    const child = children[idx];
    if (child.role === 'term' && idx + 1 < children.length && children[idx + 1].role === 'definition') {
      flushInline();
      const rendered = renderTermDefinitionPair(child, children[idx + 1], opts);
      if (rendered) appendBlock(out, rendered);
      idx += 2;
      continue;
    }
    if (isInlineFragmentRole(child.role, opts)) {
      const part = inlineMarkdown(child, opts);
      if (part) pendingInline.push(part);
      idx += 1;
      continue;
    }
    flushInline();
    if (renderCompactChromeNode(child, out, opts)) {
      idx += 1;
      continue;
    }
    renderDocumentNode(child, out, { listDepth, options: opts });
    idx += 1;
  }
  flushInline();
}

function tableCellMarkdown(cell, options = {}) {
  const opts = ensureOptions(options);
  if (cell.children.length) return formatInlineSpacing(cell.children.map(child => inlineMarkdown(child, opts)));
  return nodeText(cell);
}

function renderDefinitionTableRows(node, options = {}) {
  const rowNodes = tableRows(node);
  if (!rowNodes.length) return null;
  if (rowNodes.some(row => rowCells(row).some(cell => cell.role === 'columnheader'))) return null;
  const rendered = [];
  for (const row of rowNodes) {
    const cells = rowCells(row);
    if (cells.length !== 2) return null;
    let label = normalizeWs(tableCellMarkdown(cells[0], options));
    const value = normalizeWs(tableCellMarkdown(cells[1], options));
    if (!label || !value) return null;
    const isDefinitionLabel = label.endsWith(':') || cells[0].role === 'rowheader';
    label = label.replace(/:+$/g, '').trim();
    if (!isDefinitionLabel || label.length > 48 || /[\[\]()<>|]/.test(label)) return null;
    rendered.push(`**${label}:** ${value}`);
  }
  return rendered.length >= 2 ? rendered : null;
}

function looksLikeNumericDataCell(text) {
  const source = normalizeWs(text);
  if (!source) return false;
  return /^[+$€£¥-]?\s*(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:\s*(?:%|[A-Za-z]{1,6}))?$/.test(source);
}

function looksLikeInferredTableHeaderCell(text) {
  const source = normalizeWs(text);
  if (!source || source.length > 40 || source.split(/\s+/).length > 4) return false;
  if (looksLikeNumericDataCell(source)) return false;
  if (/[\[\]()<>|]/.test(source)) return false;
  return /[A-Za-z]/.test(source);
}

function looksLikeInferredHeaderTable(node, rows) {
  if (!normalizeWs(node.label || '')) return false;
  if (rows.length < 2) return false;
  const widths = new Set(rows.map(row => row.length));
  if (widths.size !== 1) return false;
  const header = rows[0];
  if (header.length <= 1 || !header.every(looksLikeInferredTableHeaderCell)) return false;
  return rows.slice(1).flatMap(row => row.slice(1)).some(looksLikeNumericDataCell);
}

function renderHeaderTableRows(node, options = {}) {
  const rows = [];
  for (const row of tableRows(node)) {
    const cells = [];
    for (const cell of rowCells(row)) {
      const text = tableCellMarkdown(cell, options);
      if (text || text === '') cells.push(text);
    }
    if (cells.length) rows.push(cells);
  }
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map(row => row.length));
  if (width <= 1) return null;
  const explicitHeader = hasExplicitTableHeader(node);
  if (!explicitHeader && !looksLikeInferredHeaderTable(node, rows)) return null;
  const padded = rows.map(row => [...row, ...Array(width - row.length).fill('')]);
  const esc = cell => String(cell).replace(/\|/g, '\\|');
  const rendered = [`| ${padded[0].map(esc).join(' | ')} |`];
  rendered.push(`| ${Array(width).fill('---').join(' | ')} |`);
  for (const row of padded.slice(1)) rendered.push(`| ${row.map(esc).join(' | ')} |`);
  return rendered;
}

function isSubstantiveNestedLayout(node) {
  if (node.role === 'row') return Boolean(rowCells(node).length || node.children.length);
  if (node.role === 'rowgroup') return Boolean(tableRows(node).length);
  if (['table', 'grid', 'treegrid'].includes(node.role)) return Boolean(tableRows(node).length);
  if (node.role === 'list') return node.children.some(child => child.role === 'listitem');
  return false;
}

function hasInlineContentChild(node, options = {}) {
  return node.children.some(child => isInlineFragmentRole(child.role, options) && Boolean(inlineMarkdown(child, options)));
}

function renderLayoutRow(row, out, { listDepth = 0, options = {} } = {}) {
  const opts = ensureOptions(options);
  const pendingCells = [];
  function flushCells() {
    if (pendingCells.length) {
      appendLine(out, formatInlineSpacing(pendingCells));
      pendingCells.length = 0;
    }
  }

  const cells = rowCells(row);
  if (!cells.length) {
    renderDocumentChildren(row.children, out, { listDepth, options: opts });
    return;
  }

  for (const cell of cells) {
    const nestedLayout = cell.children.filter(isSubstantiveNestedLayout);
    if (nestedLayout.length && !hasInlineContentChild(cell, opts)) {
      flushCells();
      for (const child of cell.children) {
        if (child.role === 'row') renderLayoutRow(child, out, { listDepth, options: opts });
        else if (child.role === 'rowgroup') tableRows(child).forEach(nested => renderLayoutRow(nested, out, { listDepth, options: opts }));
        else if (['table', 'grid', 'treegrid'].includes(child.role)) renderLayoutTable(child, out, { listDepth, options: opts });
        else renderDocumentNode(child, out, { listDepth, options: opts });
      }
      continue;
    }
    const text = tableCellMarkdown(cell, opts);
    if (text) pendingCells.push(text);
  }
  flushCells();
}

function renderLayoutTable(node, out, { listDepth = 0, options = {} } = {}) {
  const definitionRows = renderDefinitionTableRows(node, options);
  if (definitionRows) {
    appendBlank(out);
    out.push(...definitionRows);
    out.push('');
    return;
  }
  const rows = tableRows(node);
  if (!rows.length) {
    for (const child of node.children) renderDocumentNode(child, out, { listDepth, options });
    return;
  }
  for (const row of rows) renderLayoutRow(row, out, { listDepth, options });
}

function looksLikeSubstantiveCodeLines(lines) {
  const nonempty = lines.filter(line => String(line ?? '').trim());
  if (!nonempty.length) return false;
  if (nonempty.every(looksLikeNumericDataCell)) return false;
  return nonempty.some(line => /[A-Za-z_{}()[\];=+\-*/<>:'"`]/.test(String(line ?? '')));
}

function codeBlockText(node) {
  function rawLeafText(child) {
    if (child.role === 'text') return child.text || unquoteAccessibleName(child.value || child.label);
    if (child.label) return unquoteAccessibleName(child.label);
    if (child.value) return unquoteAccessibleName(child.value);
    return '';
  }
  function cellCodeText(cell) {
    if (cell.children.length) {
      return normalizeWs(cell.children.map(grand => codeBlockText(grand)).filter(Boolean).join(' '));
    }
    return normalizeWs(rawLeafText(cell));
  }
  function rowCodeTexts(row) {
    const cells = rowCells(row);
    if (cells.length) return cells.map(cellCodeText);
    return row.children.map(child => codeBlockText(child)).filter(Boolean);
  }

  if (node.role === 'row') {
    const rowText = rowCodeTexts(node).filter(Boolean).join(' ').replace(/[ \t]+$/g, '');
    if (rowText) return rowText;
  }

  const rowChildren = node.children.filter(child => child.role === 'row');
  if (rowChildren.length && rowChildren.length === node.children.length) {
    const rows = rowChildren.map(rowCodeTexts);
    if (rows.length && rows.every(row => row.length >= 2)) {
      const firstCol = rows.map(row => String(row[0] ?? '').trim());
      if (firstCol.every((value, index) => value === String(index + 1))) {
        const stripped = rows.map(row => row.slice(1).filter(part => part !== undefined && part !== null).join(' ').replace(/[ \t]+$/g, ''));
        if (looksLikeSubstantiveCodeLines(stripped)) return stripped.join('\n').replace(/[ \t\n]+$/g, '');
      }
    }
  }

  if (node.children.length) {
    const lines = [];
    for (const child of node.children) {
      if (['text', 'code', 'pre'].includes(child.role)) {
        const line = rawLeafText(child);
        if (line || child.role === 'text') lines.push(line);
      } else {
        const text = codeBlockText(child);
        if (text) lines.push(...text.split('\n'));
      }
    }
    if (lines.length) return lines.join('\n').replace(/[ \t\n]+$/g, '');
  }
  return nodeText(node);
}

function renderDocumentNode(node, out, { listDepth = 0, options = {} } = {}) {
  const opts = ensureOptions(options);
  const role = node.role;

  if (renderConsentNode(node, out, opts)) return;
  if (renderCompactChromeNode(node, out, opts)) return;

  if (['fragment', 'page', 'document'].includes(role)) {
    renderDocumentChildren(orderedReadableChildren(node.children, opts), out, { listDepth, options: opts });
    return;
  }
  if (['main', 'article', 'region', 'section', 'group', 'rowgroup', 'generic', 'none', 'presentation', 'dialog', 'alertdialog', 'search', 'form', 'iframe'].includes(role)) {
    renderDocumentChildren(node.children, out, { listDepth, options: opts });
    return;
  }
  if (role === 'listbox') {
    renderDocumentChildren(node.children, out, { listDepth, options: opts });
    return;
  }
  if (isStructuralSkipRole(role)) {
    if (opts.compactChrome && !opts.emitControls) return;
    renderDocumentChildren(node.children, out, { listDepth, options: opts });
    return;
  }
  if (['meter', 'progressbar'].includes(role)) {
    const label = cleanGeneratedDocUiText(node.label);
    const valueText = node.children.length ? formatInlineSpacing(node.children.map(child => inlineMarkdown(child, opts))) : cleanGeneratedDocUiText(node.value);
    let text = label && valueText ? `${label}: ${valueText}` : label || valueText;
    if (opts.emitRefs && node.ref) text = text ? `${text} ${node.ref}` : node.ref;
    if (text && !isGeneratedDocUiLabel(text)) appendLine(out, text);
    return;
  }
  if (isControlRole(role)) {
    const control = controlMarkdown(node, opts);
    if (control) appendLine(out, control);
    return;
  }
  if (role === 'heading') {
    const text = cleanGeneratedHeadingText(nodeText(node));
    if (text && !isGeneratedDocUiLabel(text)) {
      const level = Math.max(1, Math.min(6, Number.isFinite(node.level) ? node.level : 2));
      appendBlank(out);
      appendLine(out, `${'#'.repeat(level)} ${escapeMdText(text)}`);
      out.push('');
    }
    return;
  }
  if (['paragraph', 'caption', 'status', 'alert', 'note', 'time'].includes(role)) {
    const text = node.children.length ? inlineMarkdown(node, opts) : escapeMdBlockText(cleanGeneratedDocUiText(nodeText(node)));
    if (text && !isGeneratedDocUiLabel(text)) appendBlock(out, text);
    return;
  }
  if (role === 'blockquote') {
    const text = node.children.length ? inlineMarkdown(node, opts) : cleanGeneratedDocUiText(nodeText(node));
    if (text) {
      appendBlank(out);
      for (const line of text.split('\n')) appendLine(out, `> ${line.trim()}`);
      out.push('');
    }
    return;
  }
  if (role === 'list') {
    for (const child of node.children) renderDocumentNode(child, out, { listDepth, options: opts });
    return;
  }
  if (role === 'listitem') {
    const taskParts = taskListitemParts(node, opts);
    const nestedLists = node.children.filter(child => child.role === 'list');
    if (taskParts) {
      const [marker, text, control] = taskParts;
      const rendered = opts.emitControls && control ? `${marker} ${text} ${control}` : `${marker} ${text}`;
      appendLine(out, `${'  '.repeat(listDepth)}- ${rendered}`);
    } else {
      const inlineChildren = node.children.filter(child => child.role !== 'list');
      let text = '';
      if (inlineChildren.length) text = formatInlineSpacing(inlineChildren.map(child => inlineMarkdown(child, opts)));
      else if (node.label) text = escapeMdText(cleanGeneratedDocUiText(nodeText(node)));
      else if (!nestedLists.length) text = node.children.length ? inlineMarkdown(node, opts) : cleanGeneratedDocUiText(nodeText(node));
      if (text && !isGeneratedDocUiLabel(text)) appendLine(out, `${'  '.repeat(listDepth)}- ${text}`);
    }
    for (const nested of nestedLists) {
      for (const child of nested.children) renderDocumentNode(child, out, { listDepth: listDepth + 1, options: opts });
    }
    return;
  }
  if (role === 'link') {
    if (!opts.emitRefs && isLowValueDocumentActionLink(node)) return;
    const text = inlineMarkdown(node, opts);
    if (text) appendLine(out, text);
    return;
  }
  if (['img', 'image'].includes(role)) {
    const label = cleanGeneratedDocUiText(nodeText(node));
    if (label) {
      const href = node.props.url;
      const refSuffix = agentRefSuffix(node, opts);
      const text = href ? `![${escapeMdLinkLabel(label)}](${sanitizeDisplayHref(href)})${refSuffix}` : `![${escapeMdLinkLabel(label)}]${refSuffix}`;
      if (!out.length || !out.at(-1).includes(label)) appendLine(out, text);
    }
    return;
  }
  if (['table', 'grid', 'treegrid'].includes(role)) {
    const definitionRows = renderDefinitionTableRows(node, opts);
    if (definitionRows) {
      appendBlank(out);
      out.push(...definitionRows);
      out.push('');
      return;
    }
    const renderedRows = renderHeaderTableRows(node, opts);
    if (renderedRows) {
      const label = cleanGeneratedDocUiText(node.label);
      appendBlank(out);
      if (label) {
        appendLine(out, `**${label}**`);
        out.push('');
      }
      out.push(...renderedRows);
      out.push('');
    } else {
      renderLayoutTable(node, out, { listDepth, options: opts });
    }
    return;
  }
  if (role === 'row') {
    renderLayoutRow(node, out, { listDepth, options: opts });
    return;
  }
  if (['cell', 'gridcell', 'columnheader', 'rowheader'].includes(role)) {
    const text = tableCellMarkdown(node, opts);
    if (text) appendLine(out, text);
    return;
  }
  if (['code', 'pre'].includes(role)) {
    const text = codeBlockText(node).split('\n').map(cleanGeneratedDocCodeLine).join('\n').replace(/[ \t\n]+$/g, '');
    if (text) {
      const fence = codeFenceFor(text);
      const language = codeLanguageLabel(node);
      appendBlank(out);
      out.push(`${fence}${language}`);
      out.push(text);
      out.push(fence);
      out.push('');
    }
    return;
  }
  if (['strong', 'emphasis', 'em', 'italic'].includes(role)) {
    if (node.label) {
      const text = inlineMarkdown(node, opts);
      if (text) appendLine(out, text);
      return;
    }
    for (const child of node.children) renderDocumentNode(child, out, { listDepth, options: opts });
    return;
  }
  if (node.children.length) {
    renderDocumentChildren(node.children, out, { listDepth, options: opts });
    return;
  }
  let text = cleanGeneratedDocUiText(nodeText(node));
  if (text && !isGeneratedDocUiLabel(text)) {
    if (opts.emitRefs && node.ref) text = `${text}${node.ref}`;
    appendLine(out, text);
  }
}

function trimDuplicateTitleHeader(lines, title) {
  const titleNorm = normalizeWs(title).toLocaleLowerCase();
  if (!titleNorm) return lines;
  if (lines.some(line => {
    const stripped = String(line ?? '').trim();
    if (!stripped.startsWith('#')) return false;
    return normalizeWs(stripped.replace(/^#+/, '')).toLocaleLowerCase() === titleNorm;
  })) return lines;
  return [`# ${title}`, '', ...lines];
}

function isSkipContentMarkdownLine(line) {
  const text = normalizeWs(line).toLocaleLowerCase();
  if (!text) return false;
  return text === '[skip to content](#content)' || text === '[skip to main content](#main)' || text === 'skip to content';
}

function postprocessMarkdownLines(lines) {
  const processed = [];
  let activeFence = '';
  for (const raw of lines) {
    const line = String(raw ?? '').replace(/[ \t]+$/g, '');
    const fence = markdownFenceToken(line);
    if (fence) {
      processed.push(line);
      if (activeFence && line.trim() === activeFence) activeFence = '';
      else if (!activeFence) activeFence = fence;
      continue;
    }
    if (activeFence) {
      processed.push(line);
      continue;
    }
    if (isSkipContentMarkdownLine(line)) continue;
    processed.push(line);
  }
  return processed;
}

function renderDocumentRootsRaw(nodes, options = {}) {
  const opts = ensureOptions(options);
  const out = [];
  for (const node of nodes) renderDocumentNode(node, out, { options: opts });
  return out;
}

function renderDocumentRoots(nodes, options = {}) {
  const raw = renderDocumentRootsRaw(nodes, options);
  return normalizeRenderedLines(postprocessMarkdownLines(raw));
}

function linesHaveMeaningfulDocumentContent(lines) {
  return lines.some(line => String(line ?? '').trim());
}

function deterministicBrowserMarkdown(snapshotText, { title = '', options = {}, assumeAriaSnapshot = true } = {}) {
  const source = String(snapshotText ?? '');
  if (!source.trim()) return '';
  const root = parseAriaSnapshot(source, { assumeAriaSnapshot });
  if (!root.children.length) return source.trim();
  const opts = ensureOptions(options);
  prepareA11yMarkdownTree(root);
  let bodyOut = renderDocumentRoots([root], opts);
  if (!linesHaveMeaningfulDocumentContent(bodyOut)) {
    bodyOut = renderDocumentRoots([root], {
      emitRefs: opts.emitRefs,
      emitControls: opts.emitControls,
      readableOrder: false,
      compactChrome: false,
    });
  }
  const out = trimDuplicateTitleHeader(bodyOut, title);
  return out.join('\n').trim();
}

function renderDocumentMarkdown(snapshotText, { title = '', assumeAriaSnapshot = true } = {}) {
  return deterministicBrowserMarkdown(snapshotText, {
    title,
    assumeAriaSnapshot,
    options: { emitRefs: false, emitControls: false, readableOrder: true, compactChrome: true },
  });
}

function renderAgentMarkdown(snapshotText, { title = '', assumeAriaSnapshot = true } = {}) {
  return deterministicBrowserMarkdown(snapshotText, {
    title,
    assumeAriaSnapshot,
    options: { emitRefs: true, emitControls: true, readableOrder: true, compactChrome: true },
  });
}

function renderMarkdownFromAriaSnapshot(snapshotText, { view = 'document', title = '', assumeAriaSnapshot = true } = {}) {
  if (view === 'document') return renderDocumentMarkdown(snapshotText, { title, assumeAriaSnapshot });
  if (view === 'agent') return renderAgentMarkdown(snapshotText, { title, assumeAriaSnapshot });
  throw new Error(`Unsupported markdown view: ${view}`);
}

function windowMarkdown(markdown, offset = 0) {
  const source = String(markdown ?? '');
  if (!source) return { text: '', truncated: false, totalChars: 0, offset: 0, hasMore: false, nextOffset: null };
  const total = source.length;
  if (total <= MAX_MARKDOWN_CHARS) {
    return { text: source, truncated: false, totalChars: total, offset: 0, hasMore: false, nextOffset: null };
  }
  const contentBudget = MAX_MARKDOWN_CHARS - MARKDOWN_TAIL_CHARS - 200;
  const tail = source.slice(-MARKDOWN_TAIL_CHARS);
  const clampedOffset = Math.min(Math.max(0, Number.parseInt(offset, 10) || 0), Math.max(0, total - MARKDOWN_TAIL_CHARS));
  const chunk = source.slice(clampedOffset, clampedOffset + contentBudget);
  const chunkEnd = clampedOffset + contentBudget;
  const hasMore = chunkEnd < total - MARKDOWN_TAIL_CHARS;
  const prefix = clampedOffset > 0 ? `[... continued from char ${clampedOffset} of ${total}. ...]\n` : '';
  const marker = hasMore
    ? `\n[... truncated at char ${chunkEnd} of ${total}. Call markdown with offset=${chunkEnd} to see more. Pagination links below. ...]\n`
    : '\n';
  return {
    text: prefix + chunk + marker + tail,
    truncated: true,
    totalChars: total,
    offset: clampedOffset,
    hasMore,
    nextOffset: hasMore ? chunkEnd : null,
  };
}

export {
  AriaNode,
  MAX_MARKDOWN_CHARS,
  MARKDOWN_TAIL_CHARS,
  parseAriaSnapshot,
  renderAgentMarkdown,
  renderDocumentMarkdown,
  renderMarkdownFromAriaSnapshot,
  windowMarkdown,
};
