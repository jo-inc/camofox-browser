import { describe, expect, test } from '@jest/globals';

/**
 * Logic extracted from .github/workflows/auto-close-old-reports.yml
 * for unit testing triage decisions.
 */
function triageIssue({ body = '', labels = [] }) {
  const MIN_VERSION = [1, 10, 0];
  const comments = [];
  let action = 'keep_open';

  // Parse "- **version:** X.Y.Z" from issue body
  const match = body.match(/\*\*[Vv]ersion:\*\*\s*v?(\d+\.\d+\.\d+)/);
  if (!match) {
    action = 'close_no_version';
    comments.push('No version found');
    return { action, comments };
  }

  const parts = match[1].split('.').map(Number);
  let dominated = false;
  for (let i = 0; i < MIN_VERSION.length; i++) {
    if ((parts[i] || 0) > MIN_VERSION[i]) { dominated = false; break; }
    if ((parts[i] || 0) < MIN_VERSION[i]) { dominated = true; break; }
  }

  if (!dominated) {
    if (labels.includes('likely-sleep')) {
      return { action: 'close_likely_sleep', comments: ['Closing — classified as OS sleep/suspend'] };
    }

    if (labels.includes('stuck')) {
      const tabMatch = body.match(/\*\*active tabs:\*\*\s*(\d+)/);
      if (tabMatch && parseInt(tabMatch[1], 10) === 0) {
        return { action: 'close_stuck_zero_tabs', comments: ['Closing — event loop stall with no active tabs'] };
      }
    }

    if (labels.includes('memory-leak')) {
      const growthMatch = body.match(/growth(?:Mb)?:\s*(\d+)/i) || body.match(/Native memory grew by\s*(\d+)MB/i);
      const growthMb = growthMatch ? parseInt(growthMatch[1], 10) : null;
      const ctxMatch = body.match(/\*\*browser contexts:\*\*\s*(\d+)/);
      const tabMatch = body.match(/\*\*active tabs:\*\*\s*(\d+)/);
      const sessionsMatch = body.match(/"sessions":\s*(\d+)/);
      const activeSessions = ctxMatch ? parseInt(ctxMatch[1], 10) : (sessionsMatch ? parseInt(sessionsMatch[1], 10) : 0);

      const maxAllowedGrowth = activeSessions > 0 ? 800 : 400;

      if (growthMb !== null && growthMb < maxAllowedGrowth) {
        return {
          action: 'close_within_operational_limits',
          growthMb,
          activeSessions,
          comments: [`Closing — native memory growth of ${growthMb}MB is within expected operational limits`],
        };
      }

      const isIdle = activeSessions === 0 && (!tabMatch || parseInt(tabMatch[1], 10) === 0);
      if (isIdle) {
        return { action: 'close_idle_self_healing', comments: ['Closing — native memory growth detected with no active sessions.'] };
      }
    }

    return { action: 'keep_open', comments: [] };
  }

  return {
    action: 'close_old_version',
    version: match[1],
    comments: [`Closing — reported from v${match[1]}, minimum supported is v${MIN_VERSION.join('.')}.`],
  };
}

describe('auto-close-old-reports triage workflow', () => {
  test('closes issue #10588 due to outdated version (v1.8.0 < v1.10.0)', () => {
    const issue10588Body = `
> Auto-reported by camofox-crash-reporter. All data is anonymized.

## Environment
- **version:** 1.8.0
- **node:** v22.22.2
- **platform:** darwin
- **uptime:** 1496 min

## Resources
- **node RSS:** 601 MB
- **node heap:** 279 / 292 MB
- **active handles:** 6

## Error
\`\`\`
Native memory grew by 204MB (baseline: 118MB, current: 322MB, high-water: 322MB)
\`\`\`
`;
    const result = triageIssue({ body: issue10588Body, labels: ['auto-report', 'memory-leak'] });
    expect(result.action).toBe('close_old_version');
    expect(result.version).toBe('1.8.0');
    expect(result.comments[0]).toContain('minimum supported is v1.10.0');
  });

  test('closes issue #10590 (v1.14.0 active session with growth 427MB < 800MB limit)', () => {
    const issue10590Body = `
> Auto-reported by camofox-crash-reporter. All data is anonymized.

## Environment
- **version:** 1.14.0
- **node:** v24.8.0
- **platform:** win32
- **uptime:** 14 min

## Resources
- **node RSS:** 625 MB
- **node heap:** 79 / 82 MB
- **browser contexts:** 1
- **active tabs:** 1
- **active handles:** 8

## Error
\`\`\`
Native memory grew by 427MB (baseline: 119MB, current: 546MB, high-water: 546MB)
\`\`\`

## Native Memory Details
- **baseline:** 119 MB
- **current:** 546 MB
- **high-water:** 546 MB
- **growth:** 427 MB
- **node RSS:** 625 MB
- **heap used:** 79 MB
- **external:** 479 MB
- **browser RSS (last seen):** not captured (browser already dead)

<details><summary>Context</summary>

\`\`\`json
{
  "sessions": 1,
  "summary": [
    {
      "session": "agent1",
      "tabs": 1,
      "urls": [
        "<http-url>"
      ]
    }
  ]
}
\`\`\`

</details>
`;
    const result = triageIssue({ body: issue10590Body, labels: ['auto-report', 'memory-leak'] });
    expect(result.action).toBe('close_within_operational_limits');
    expect(result.growthMb).toBe(427);
    expect(result.activeSessions).toBe(1);
    expect(result.comments[0]).toContain('within expected operational limits');
  });

  test('closes report if sessions/contexts are 0 (idle self-healing handles it)', () => {
    const body = `
## Environment
- **version:** 1.14.0

## Resources
- **browser contexts:** 0
- **active tabs:** 0

## Error
\`\`\`
Native memory grew by 642MB
\`\`\`
`;
    const result = triageIssue({ body, labels: ['auto-report', 'memory-leak'] });
    expect(result.action).toBe('close_idle_self_healing');
  });

  test('keeps genuine unbounded leak on modern version with active sessions open (> 800MB)', () => {
    const body = `
## Environment
- **version:** 1.14.0

## Resources
- **browser contexts:** 1
- **active tabs:** 2

## Error
\`\`\`
Native memory grew by 950MB
\`\`\`
`;
    const result = triageIssue({ body, labels: ['auto-report', 'memory-leak'] });
    expect(result.action).toBe('keep_open');
  });

  test('closes likely-sleep issues', () => {
    const body = `- **version:** 1.14.0`;
    const result = triageIssue({ body, labels: ['likely-sleep', 'auto-report'] });
    expect(result.action).toBe('close_likely_sleep');
  });

  test('closes stuck event loop when active tabs is 0', () => {
    const body = `
- **version:** 1.14.0
- **active tabs:** 0
`;
    const result = triageIssue({ body, labels: ['stuck', 'auto-report'] });
    expect(result.action).toBe('close_stuck_zero_tabs');
  });
});
