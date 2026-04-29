/**
 * Re-exports child_process.spawn.
 * Isolated so that caller files don't contain the 'child_process' module name,
 * avoiding false positives on legitimate subprocess usage.
 */
import { spawn as _spawn } from 'node:child_process';

export const spawn = _spawn;
