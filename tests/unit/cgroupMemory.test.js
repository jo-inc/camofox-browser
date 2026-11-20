import { describe, test, expect, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cgroupMemory } from '../../lib/cgroup-memory.js';

const MB = 1048576;
let dir;

function fakeCgroup(files) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-'));
  fs.writeFileSync(path.join(dir, 'cgroup'), '0::/svc.service\n');
  fs.mkdirSync(path.join(dir, 'svc.service'));
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'svc.service', name), value);
  return { procCgroup: path.join(dir, 'cgroup'), root: dir };
}

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('cgroupMemory', () => {
  const pressure = 'some avg10=25.00 avg60=1.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';

  test('reads used, anon, cap and stall, and flags a stalled cgroup at its cap', () => {
    const mem = cgroupMemory(fakeCgroup({
      'memory.current': String(4000 * MB),
      'memory.high': String(4096 * MB),
      'memory.max': 'max',
      'memory.pressure': pressure,
      'memory.stat': `file ${3000 * MB}\nanon ${900 * MB}\nanon_thp 0\n`,
    }));
    expect(mem).toEqual({ usedMb: 4000, anonMb: 900, capMb: 4096, stalledPct: 25, nearCap: true, atCap: true });
  });

  test('falls back to memory.max, and anonMb is null without an anon line', () => {
    const mem = cgroupMemory(fakeCgroup({
      'memory.current': String(100 * MB),
      'memory.high': 'max',
      'memory.max': String(2048 * MB),
      'memory.pressure': pressure,
      'memory.stat': 'file 0\n',
    }));
    expect(mem).toMatchObject({ usedMb: 100, anonMb: null, capMb: 2048, nearCap: false, atCap: false });
  });

  test('is null off cgroup v2', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-'));
    fs.writeFileSync(path.join(dir, 'cgroup'), '1:memory:/x\n');
    expect(cgroupMemory({ procCgroup: path.join(dir, 'cgroup'), root: dir })).toBeNull();
  });
});
