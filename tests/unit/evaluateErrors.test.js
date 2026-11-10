/**
 * /tabs/:tabId/evaluate errors must flow through handleRouteError so
 * clients get structured retryable codes instead of a bare 500.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  browserErrorStatus,
  browserErrorCode,
  browserErrorRecovery,
  isRetryableBrowserError,
  isInvalidExpressionError,
} from '../../lib/browser-errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

describe('evaluate route error handling', () => {
  test('evaluate errors are routed through handleRouteError', () => {
    const start = serverSource.indexOf("app.post('/tabs/:tabId/evaluate'");
    expect(start).toBeGreaterThan(-1);
    const section = serverSource.slice(start, serverSource.indexOf('\napp.', start + 1));
    expect(section).toContain('handleRouteError(err, req, res)');
    expect(section).not.toContain('res.status(500)');
  });

  test('tab creation refuses at the memory cap before opening a page', () => {
    const start = serverSource.indexOf("app.post('/tabs', async (req, res) => {");
    const route = serverSource.slice(start, serverSource.indexOf('\napp.', start + 1));
    expect(route.indexOf('if (mem?.atCap) return memoryCapResponse(res, mem);'))
      .toBeLessThan(route.indexOf('createPageWithRecoveryForUser'));
  });

  test('an evaluate timeout does not destroy the tab', () => {
    const start = serverSource.indexOf("app.post('/tabs/:tabId/evaluate'");
    const section = serverSource.slice(start, serverSource.indexOf('\napp.', start + 1));
    expect(section).not.toContain('destroyTimedOutTab');
    expect(section).toContain("code: 'evaluate_timeout'");
  });

  test('the idle reapers spare a tab while an evaluate runs', () => {
    const tabReaper = serverSource.slice(serverSource.indexOf('// Per-tab inactivity reaper'));
    expect(tabReaper).toContain('if (!tabState._lastReaperCheck || isEvaluating(tabState, now)) {');
    const sessionReaper = serverSource.slice(serverSource.indexOf('// Cleanup stale sessions'));
    expect(sessionReaper.indexOf('if (evaluating) session.lastAccess = now;'))
      .toBeLessThan(sessionReaper.indexOf('SESSION_TIMEOUT_MS > 0 && now - session.lastAccess'));
  });

  test('evaluate during a navigation normalizes to 409 navigation_race', () => {
    const err = new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
    expect(browserErrorStatus(err)).toBe(409);
    expect(browserErrorCode(err)).toBe('navigation_race');
    expect(isRetryableBrowserError(err)).toBe(true);
  });

  test('evaluate on a dead target normalizes to 503 session_expired', () => {
    const err = new Error('page.evaluate: Target page, context or browser has been closed');
    expect(browserErrorStatus(err)).toBe(503);
    expect(browserErrorCode(err)).toBe('session_expired');
    expect(isRetryableBrowserError(err)).toBe(true);
    expect(browserErrorRecovery(err)).toBe('retry');
  });
});

// Messages below are verbatim from camoufox (SpiderMonkey) via page.evaluate.
describe('evaluate expression syntax errors', () => {
  const syntaxErrors = [
    ['top-level return',        'page.evaluate: return not in function'],
    ['return inside a block',   'page.evaluate: return not in function'],
    ['top-level await',         'page.evaluate: await is only valid in async functions, async generators and modules'],
    ['stray brace',             "page.evaluate: expected expression, got '}'"],
    ['bad operator sequence',   "page.evaluate: expected expression, got '*'"],
    ['keyword typo',            "page.evaluate: unexpected token: '{'"],
    ['unclosed call',           'page.evaluate: missing ) after argument list'],
    ['unclosed function body',  'page.evaluate: missing } after function body'],
    ['assignment without name', "page.evaluate: missing variable name, got '='"],
    ['unterminated string',     "page.evaluate: '' literal not terminated before end of script"],
    ['unterminated regex',      'page.evaluate: unterminated regular expression literal'],
    ['const redeclaration',     'page.evaluate: redeclaration of const a'],
    ['unclosed block',          'page.evaluate: missing } in compound statement'],
    ['unclosed parenthesis',    'page.evaluate: missing ) in parenthetical'],
    ['unclosed array',          'page.evaluate: missing ] after element list'],
    ['dangling member access',  'page.evaluate: missing name after . operator'],
    ['const without value',     'page.evaluate: missing = in const declaration'],
    ['bare hex prefix',         "page.evaluate: missing hexadecimal digits after '0x'"],
    ['unnamed class statement', 'page.evaluate: class statement requires a name'],
    ['let as a binding name',   "page.evaluate: a lexical declaration can't define a 'let' binding"],
    ['empty object member',     "page.evaluate: expected property name, got ','"],
    ['assignment to a literal', 'page.evaluate: invalid assignment left-hand side'],
    ['stray character',         'page.evaluate: illegal character U+0040'],
    ['bare hash',               "page.evaluate: '#' not followed by identifier"],
    ['yield outside generator', 'page.evaluate: yield expression is only valid in generators'],
    ['import in expression',    'page.evaluate: import declarations may only appear at top level of a module'],
  ];

  test.each(syntaxErrors)('%s is a 400 invalid_expression', (_label, message) => {
    const err = new Error(message);
    expect(isInvalidExpressionError(err)).toBe(true);
    expect(browserErrorStatus(err)).toBe(400);
    expect(browserErrorCode(err)).toBe('invalid_expression');
  });

  test('a syntax error is not retryable — the caller must fix the JavaScript', () => {
    const err = new Error('page.evaluate: return not in function');
    expect(isRetryableBrowserError(err)).toBe(false);
    expect(browserErrorRecovery(err)).toBeNull();
  });

  test('an explicit invalid_expression code is honoured', () => {
    const err = Object.assign(new Error('nope'), { code: 'invalid_expression' });
    expect(isInvalidExpressionError(err)).toBe(true);
    expect(browserErrorStatus(err)).toBe(400);
  });

  // Runtime failures depend on page state, so they are not the caller's mistake and
  // must keep falling through to the existing handling.
  const runtimeErrors = [
    ['ReferenceError', 'page.evaluate: someUndefinedGlobal is not defined'],
    ['TypeError',      'page.evaluate: can\'t access property "foo" of null'],
    ['JSON.parse of bad data', "page.evaluate: JSON.parse: expected property name or '}' at line 1 column 2 of the JSON data"],
    ['RegExp built from data', 'page.evaluate: unterminated parenthetical'],
  ];

  test.each(runtimeErrors)('%s is not reclassified as invalid_expression', (_label, message) => {
    const err = new Error(message);
    expect(isInvalidExpressionError(err)).toBe(false);
    expect(browserErrorCode(err)).not.toBe('invalid_expression');
  });

  test('selector errors keep their own code', () => {
    const err = new Error('Unexpected token while parsing selector "div["');
    expect(browserErrorCode(err)).toBe('invalid_selector');
    expect(browserErrorStatus(err)).toBe(400);
  });
});
