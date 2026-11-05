/**
 * Page-state classifier.
 *
 * Pure function: given a page's URL, title and visible text, returns what kind
 * of page the agent is looking at, so it can decide what to do next (solve
 * nothing, ask the user, dismiss an overlay, or just read the page).
 *
 * Rules are ordered by priority: the first matching rule wins. Every rule is a
 * specific phrase, not a single loose word, so ordinary articles that mention
 * "cookies" or "login" are not misclassified.
 */

export const PAGE_STATE_KINDS = Object.freeze([
  'captcha',
  'block',
  'two_factor',
  'login_wall',
  'consent',
  'no_results',
  'ok',
]);

/**
 * Page kinds where a person has to act. The agent cannot solve these, so it
 * pauses and hands the tab to the user. The reason text is shown to the user.
 */
export const HANDOFF_REASON_BY_STATE = Object.freeze({
  captcha: 'This page needs a human check. Please complete it on this page.',
  login_wall: 'This page needs you to sign in. Please sign in on this page.',
  two_factor: 'This page is asking for a verification code. Please enter it on this page.',
});

const MAX_TEXT_CHARS = 20000;

const RULES = [
  {
    kind: 'captcha',
    reason: 'captcha_or_challenge',
    test: (haystack) =>
      /captcha|verify you are human|are you a robot|unusual traffic from your computer|press and hold|challenge-platform|cf-challenge|checking your browser before/i.test(haystack),
  },
  {
    kind: 'block',
    reason: 'access_denied',
    test: (haystack) =>
      /access denied|request blocked|you have been blocked|this request was blocked|error 1020|pardon our interruption/i.test(haystack),
  },
  {
    kind: 'two_factor',
    reason: 'verification_code_prompt',
    test: (haystack) =>
      /two-factor authentication|2-step verification|enter the (\d-digit )?(verification |security )?code|authenticator app|we sent (a|you a) (code|verification code)/i.test(haystack),
  },
  {
    kind: 'login_wall',
    reason: 'sign_in_required',
    test: (haystack, url) =>
      /\/(login|log-in|signin|sign-in|accounts\/login)(\/|\?|$)/i.test(url) ||
      /sign in to continue|log in to continue|sign in to see more|create an account to continue|please sign in to/i.test(haystack),
  },
  {
    kind: 'consent',
    reason: 'cookie_or_privacy_banner',
    test: (haystack) =>
      /(cookie|privacy) (settings|preferences|choices)/i.test(haystack) &&
      /(accept all|reject all|accept cookies|manage cookies|reject non-essential)/i.test(haystack),
  },
  {
    kind: 'no_results',
    reason: 'empty_result_set',
    test: (haystack) =>
      /no results found|did not match any|no matches found|nothing matched your search|we couldn'?t find any|0 results for/i.test(haystack),
  },
];

/**
 * @param {{url?: string, title?: string, text?: string}} input
 * @returns {{kind: string, reasons: string[]}}
 */
export function classifyPageState({ url = '', title = '', text = '' } = {}) {
  const safeUrl = String(url || '');
  const safeTitle = String(title || '');
  const safeText = String(text || '').slice(0, MAX_TEXT_CHARS);
  const haystack = `${safeTitle}\n${safeText}`;

  for (const rule of RULES) {
    if (rule.test(haystack, safeUrl)) {
      return { kind: rule.kind, reasons: [rule.reason] };
    }
  }
  return { kind: 'ok', reasons: [] };
}
