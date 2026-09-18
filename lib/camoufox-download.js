import { DefaultAddons, maybeDownloadAddons } from 'camoufox-js/dist/addons.js';
import { ALLOW_GEOIP, downloadMMDB } from 'camoufox-js/dist/locale.js';
import { CamoufoxFetcher } from 'camoufox-js/dist/pkgman.js';

// camoufox-js does not currently expose its fetch command from the public
// entrypoint. Keep its pinned version in package.json while using the same
// downloader implementation as `npx camoufox-js fetch`, without spawning a
// shell or a second Node process during this package's lifecycle hook.
export async function downloadBundledCamoufox({
  createFetcher = () => new CamoufoxFetcher(),
  shouldDownloadGeoIp = ALLOW_GEOIP,
  downloadGeoIp = downloadMMDB,
  downloadAddons = maybeDownloadAddons,
} = {}) {
  const fetcher = createFetcher();
  await fetcher.install();

  if (shouldDownloadGeoIp) downloadGeoIp();
  await downloadAddons(DefaultAddons);
}
