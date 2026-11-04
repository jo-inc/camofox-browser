import { describe, test, expect } from '@jest/globals';
import { classifyPageState, PAGE_STATE_KINDS } from '../../lib/page-state.js';

describe('classifyPageState (unit)', () => {
  test('exposes the full set of kinds', () => {
    expect(PAGE_STATE_KINDS).toEqual([
      'captcha', 'block', 'two_factor', 'login_wall', 'consent', 'no_results', 'ok',
    ]);
  });

  test('plain content page is ok', () => {
    expect(classifyPageState({
      url: 'https://example.com/article',
      title: 'Local news',
      text: 'Council approves new bike lanes after a long debate.',
    })).toEqual({ kind: 'ok', reasons: [] });
  });

  test('captcha wording is detected', () => {
    const result = classifyPageState({ title: 'Just a moment', text: 'Checking your browser before accessing the site. challenge-platform' });
    expect(result.kind).toBe('captcha');
    expect(result.reasons).toEqual(['captcha_or_challenge']);
  });

  test('access denied page is a block', () => {
    expect(classifyPageState({ title: 'Access Denied', text: 'You do not have permission. Error 1020' }).kind).toBe('block');
  });

  test('verification code prompt is two_factor', () => {
    expect(classifyPageState({ title: 'Sign in', text: 'Enter the 6-digit code from your authenticator app.' }).kind).toBe('two_factor');
  });

  test('login path in URL is a login wall', () => {
    expect(classifyPageState({ url: 'https://shop.example.com/login?next=/cart', title: 'Welcome', text: '' }).kind).toBe('login_wall');
  });

  test('sign-in prompt text is a login wall', () => {
    expect(classifyPageState({ url: 'https://news.example.com/a', title: 'Story', text: 'Sign in to continue reading this story.' }).kind).toBe('login_wall');
  });

  test('cookie banner with accept and reject controls is consent', () => {
    const result = classifyPageState({
      title: 'Home',
      text: 'Cookie settings. We use cookies. Accept all   Reject all   Manage cookies',
    });
    expect(result.kind).toBe('consent');
  });

  test('the word cookie alone does not trigger consent', () => {
    expect(classifyPageState({ title: 'Recipes', text: 'Bake the cookies for 12 minutes.' }).kind).toBe('ok');
  });

  test('empty search results are no_results', () => {
    expect(classifyPageState({ title: 'Search', text: 'No results found for "qzxv"' }).kind).toBe('no_results');
  });

  test('priority: captcha beats consent when both are present', () => {
    const result = classifyPageState({
      title: 'Verify you are human',
      text: 'Accept all cookies. Press and hold to confirm.',
    });
    expect(result.kind).toBe('captcha');
  });

  test('missing fields are tolerated', () => {
    expect(classifyPageState()).toEqual({ kind: 'ok', reasons: [] });
    expect(classifyPageState({ url: null, title: undefined, text: null })).toEqual({ kind: 'ok', reasons: [] });
  });

  test('only the first 20000 characters of text are scanned', () => {
    const filler = 'a'.repeat(20000);
    expect(classifyPageState({ title: 'x', text: `${filler} No results found` }).kind).toBe('ok');
  });
});
