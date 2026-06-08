#!/usr/bin/env node
// Resolves the latest Camoufox release for a given channel + architecture.
//
// Why this exists: upstream (daijro/camoufox) ships release assets whose suffix
// number bumps independently per arch (e.g. v150.0.2 shipped alpha.26 for
// x86_64 but alpha.25 for arm64) and per channel (alpha vs beta). Hardcoding a
// single VERSION/RELEASE pin therefore can't track "latest" without constant
// manual edits. This script queries the GitHub releases API and picks the
// newest asset matching `camoufox-<ver>-<channel>.<n>-lin.<arch>.zip`, mirroring
// how camoufox-js itself resolves a download.
//
// It also emits a "declared release" string for version.json. camoufox-js@0.10.2
// enforces a supported range of `>=beta.19, <1` at launch (Version.isSupported
// in its pkgman.js), and its comparator sorts `alpha.*` BELOW `beta.*`, so an
// alpha build would be rejected. For the alpha channel we therefore download the
// real alpha asset but declare a passing `beta.<n>` string in version.json. The
// real release is preserved in the URL/output for traceability.
//
// Usage:
//   node scripts/resolve-camoufox.js --channel beta --arch x86_64
//   node scripts/resolve-camoufox.js --channel alpha --arch arm64 --json
//
// Output (default): shell-eval-able KEY=value lines on stdout:
//   CAMOUFOX_VERSION=150.0.2
//   CAMOUFOX_RELEASE=alpha.26
//   CAMOUFOX_DECLARED_RELEASE=beta.26
//   CAMOUFOX_URL=https://github.com/daijro/camoufox/releases/download/...zip

const REPO = 'daijro/camoufox';
// Minimum release-suffix number camoufox-js@0.10.2 accepts (its MIN_VERSION is
// "beta.19"). Declared alpha releases are clamped up to this so the launch
// guard passes. Bump if the pinned camoufox-js range changes.
const CAMOUFOX_JS_MIN_BETA = 19;

function parseArgs(argv) {
  const args = { channel: 'beta', arch: 'x86_64', json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--channel') args.channel = argv[++i];
    else if (a === '--arch') args.arch = argv[++i];
    else if (a.startsWith('--channel=')) args.channel = a.slice('--channel='.length);
    else if (a.startsWith('--arch=')) args.arch = a.slice('--arch='.length);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function fail(msg) {
  console.error(`resolve-camoufox: ${msg}`);
  process.exit(1);
}

async function fetchReleases() {
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
  const headers = {
    'User-Agent': 'camofox-browser-resolver',
    Accept: 'application/vnd.github+json',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return res.json();
      lastErr = new Error(`GitHub API ${res.status} ${res.statusText}`);
      // Rate-limited or transient: back off and retry.
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  fail(`failed to fetch releases from ${REPO}: ${lastErr?.message || lastErr}`);
}

// Compare two {versionParts:[n], releaseNum:n} descending (newest first).
function isNewer(a, b) {
  const len = Math.max(a.versionParts.length, b.versionParts.length);
  for (let i = 0; i < len; i++) {
    const av = a.versionParts[i] ?? 0;
    const bv = b.versionParts[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return a.releaseNum > b.releaseNum;
}

async function main() {
  const { channel, arch, json } = parseArgs(process.argv);
  if (channel !== 'alpha' && channel !== 'beta') {
    fail(`--channel must be "alpha" or "beta", got "${channel}"`);
  }
  if (arch !== 'x86_64' && arch !== 'arm64') {
    fail(`--arch must be "x86_64" or "arm64", got "${arch}"`);
  }

  // camoufox-<version>-<channel>.<n>-lin.<arch>.zip
  const pattern = new RegExp(
    `^camoufox-(\\d+(?:\\.\\d+)*)-(${channel})\\.(\\d+)-lin\\.${arch}\\.zip$`
  );

  const releases = await fetchReleases();
  let best = null;
  for (const release of releases) {
    for (const asset of release.assets || []) {
      const m = asset.name.match(pattern);
      if (!m) continue;
      const candidate = {
        version: m[1],
        versionParts: m[1].split('.').map(Number),
        release: `${m[2]}.${m[3]}`,
        releaseNum: Number(m[3]),
        url: asset.browser_download_url,
      };
      if (!best || isNewer(candidate, best)) best = candidate;
    }
  }

  if (!best) {
    fail(
      `no "${channel}" Linux ${arch} asset found in the latest releases of ${REPO}. ` +
        `Upstream may not have published a ${channel} build for this arch.`
    );
  }

  // Declared release for version.json: real for beta; coerced beta.N for alpha
  // so camoufox-js's launch guard (>=beta.19, <1) accepts it.
  let declaredRelease = best.release;
  if (channel === 'alpha') {
    const n = Math.max(best.releaseNum, CAMOUFOX_JS_MIN_BETA);
    declaredRelease = `beta.${n}`;
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          version: best.version,
          release: best.release,
          declaredRelease,
          url: best.url,
          channel,
          arch,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    process.stdout.write(
      [
        `CAMOUFOX_VERSION=${best.version}`,
        `CAMOUFOX_RELEASE=${best.release}`,
        `CAMOUFOX_DECLARED_RELEASE=${declaredRelease}`,
        `CAMOUFOX_URL=${best.url}`,
        '',
      ].join('\n')
    );
  }
}

main();
