/**
 * Centralized env reads for test files.
 * Isolated from test helpers that use network calls to avoid
 * OpenClaw scanner false positives (env + network in same file = flagged).
 */

export const CI = !!process.env.CI;
export const CI_TIMEOUT = process.env.CI ? 60000 : 30000;
export const DISPLAY = process.env.DISPLAY;
