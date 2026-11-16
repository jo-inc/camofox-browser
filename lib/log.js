/**
 * Structured line logging.
 *
 * Errors go to stderr, everything else to stdout, one JSON object per line.
 *
 * Under systemd both streams arrive at PRIORITY 6, so the level field is
 * decorative and `journalctl -p err` matches nothing. Setting
 * CAMOFOX_LOG_SYSLOG_PREFIX=1 emits a leading <N>, which journald reads as
 * the priority and strips from MESSAGE. It is off by default because npm and
 * Docker consumers have nothing to strip it and a JSON log collector would
 * fail to parse the line.
 */

const SYSLOG_PRIORITY = { error: 3, warn: 4, info: 6, debug: 7 };

export function syslogPrefixEnabled(env = process.env) {
  return env.CAMOFOX_LOG_SYSLOG_PREFIX === '1';
}

export function formatLogLine(level, msg, fields = {}, env = process.env) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (!syslogPrefixEnabled(env)) return line;
  return `<${SYSLOG_PRIORITY[level] ?? SYSLOG_PRIORITY.info}>${line}`;
}

export function log(level, msg, fields = {}) {
  const line = formatLogLine(level, msg, fields);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}
