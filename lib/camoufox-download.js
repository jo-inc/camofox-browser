import { DefaultAddons, maybeDownloadAddons } from 'camoufox-js/dist/addons.js';
import { ALLOW_GEOIP, downloadMMDB } from 'camoufox-js/dist/locale.js';
import { CamoufoxFetcher } from 'camoufox-js/dist/pkgman.js';
import { pathToFileURL } from 'node:url';

// Keep the latest stable browser release tested with camoufox-js@0.11.5.
// beta.34 rejects navigator.product; beta.28 fails viewport E2E on Playwright 1.58.
export const BUNDLED_CAMOUFOX_RELEASE = '152.0.4-beta.30';

export class CompatibleCamoufoxFetcher extends CamoufoxFetcher {
  checkAsset(asset) {
    if (!asset.name.startsWith(`camoufox-${BUNDLED_CAMOUFOX_RELEASE}-`)) return null;
    return super.checkAsset(asset);
  }
}

// camoufox-js does not currently expose its fetch command from the public
// entrypoint. Keep its pinned version in package.json while using the same
// downloader implementation as `npx camoufox-js fetch`, without spawning a
// shell or a second Node process during this package's lifecycle hook.
export async function downloadBundledCamoufox({
  createFetcher = () => new CompatibleCamoufoxFetcher(),
  shouldDownloadGeoIp = ALLOW_GEOIP,
  downloadGeoIp = downloadMMDB,
  downloadAddons = maybeDownloadAddons,
} = {}) {
  const fetcher = createFetcher();
  await fetcher.install();

  if (shouldDownloadGeoIp) downloadGeoIp();
  await downloadAddons(DefaultAddons);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  downloadBundledCamoufox().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
