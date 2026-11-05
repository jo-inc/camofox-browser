// Shared helpers for the Camofox skill scripts. No dependencies.
import fs from 'node:fs';
import path from 'node:path';

export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// Prints a result line. Never prints values that look like secrets.
export function reporter() {
  const rows = [];
  return {
    pass(name, detail = '') { rows.push(['PASS', name, detail]); },
    fail(name, detail = '') { rows.push(['FAIL', name, detail]); },
    done() {
      for (const [s, n, d] of rows) console.log(`${s}  ${n}${d ? '  ' + d : ''}`);
      const failed = rows.filter((r) => r[0] === 'FAIL').length;
      console.log(failed ? `\n${failed} check(s) failed.` : `\nAll ${rows.length} checks passed.`);
      process.exitCode = failed ? 1 : 0;
    },
  };
}
