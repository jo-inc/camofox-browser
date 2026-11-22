import { CamoufoxFetcher, listInstalled } from 'camoufox';
import { allowGeoip, downloadMmdb } from 'camoufox/dist/geolocation.js';
import { ensureModel } from 'fpgen-js';
import { pathToFileURL } from 'node:url';

// The browser release the official camoufox@0.5.9 package is stamped with
// (its browser-pin.json). Each browser release bundles its default addons.
export const BUNDLED_CAMOUFOX_RELEASE = '158.0.1-beta.41';

export class CompatibleCamoufoxFetcher extends CamoufoxFetcher {
  checkAsset(asset, release) {
    if (!asset.name.startsWith(`camoufox-${BUNDLED_CAMOUFOX_RELEASE}-`)) return null;
    return super.checkAsset(asset, release);
  }
}

// The official package installs each browser under
// <cache>/camoufox/browsers/<repo>/<version>-<build>-<sha8>/ and records the
// active one in <cache>/camoufox/config.json, so ask it rather than looking
// for a flat <cache>/camoufox/version.json.
export function isBundledCamoufoxInstalled({ installed = listInstalled } = {}) {
  return installed().some(({ version }) => version.fullString === BUNDLED_CAMOUFOX_RELEASE);
}

// launchOptions() downloads the fingerprint model on first use, inside the
// server's launch-options timeout. Fetch it ahead, as `npx camoufox fetch` does.
export async function downloadFingerprintModel({ downloadModel = ensureModel } = {}) {
  await downloadModel();
}

// Use the same downloader implementation as `npx camoufox fetch`, without
// spawning a shell or a second Node process during this package's lifecycle
// hook. Releases bundle their default addons, so none are downloaded.
export async function downloadBundledCamoufox({
  createFetcher = () => new CompatibleCamoufoxFetcher(),
  shouldDownloadGeoIp = allowGeoip,
  downloadGeoIp = downloadMmdb,
  downloadModel = ensureModel,
} = {}) {
  const fetcher = await createFetcher().init();
  await fetcher.install();

  if (shouldDownloadGeoIp()) await downloadGeoIp();
  await downloadFingerprintModel({ downloadModel });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  downloadBundledCamoufox().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
