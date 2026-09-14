/**
 * Structured line logging.
 *
 * Errors go to stderr, everything else to stdout, one JSON object per line.
 */

export function formatLogLine(level, msg, fields = {}) {
  return JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
}

export function log(level, msg, fields = {}) {
  const line = formatLogLine(level, msg, fields);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}
