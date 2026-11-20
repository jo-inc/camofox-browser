import fs from 'fs';

// The service cgroup's memory against its systemd MemoryHigh (else MemoryMax); null off cgroup v2.
// Sitting near the cap is normal (cache fills it, swap absorbs anon); stalling there is what
// makes new pages time out, so atCap also needs the kernel's memory pressure (PSI).
// Page cache fills the cgroup up to its cap by design; anonMb is what the processes themselves hold.
export function cgroupMemory({ procCgroup = '/proc/self/cgroup', root = '/sys/fs/cgroup' } = {}) {
  try {
    const rel = fs.readFileSync(procCgroup, 'utf8').match(/^0::(.*)$/m)?.[1];
    if (!rel) return null;
    const read = (name) => fs.readFileSync(`${root}${rel}/${name}`, 'utf8').trim();
    const mb = (v) => (v === 'max' ? null : Math.round(Number(v) / 1048576));
    const usedMb = mb(read('memory.current'));
    const capMb = mb(read('memory.high')) ?? mb(read('memory.max'));
    const stalledPct = Number(read('memory.pressure').match(/^some avg10=([\d.]+)/m)?.[1] ?? 0);
    const anon = read('memory.stat').match(/^anon (\d+)$/m)?.[1];
    const nearCap = capMb !== null && usedMb >= capMb * 0.95;
    return { usedMb, anonMb: anon ? mb(anon) : null, capMb, stalledPct, nearCap, atCap: nearCap && stalledPct >= 20 };
  } catch {
    return null;
  }
}
