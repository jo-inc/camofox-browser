import { describe, expect, test } from '@jest/globals';
import { OS_NAME } from 'camoufox-js/dist/pkgman.js';
import { BUNDLED_CAMOUFOX_RELEASE, CompatibleCamoufoxFetcher } from '../../lib/camoufox-download.js';

describe('bundled Camoufox release selection', () => {
  test('accepts the pinned binary and rejects newer incompatible releases', () => {
    const fetcher = new CompatibleCamoufoxFetcher();
    const asset = (release) => ({
      name: `camoufox-${release}-${OS_NAME}.${fetcher.arch}.zip`,
      browser_download_url: `https://example.invalid/${release}`,
    });

    expect(fetcher.checkAsset(asset(BUNDLED_CAMOUFOX_RELEASE))?.[0].fullString)
      .toBe(BUNDLED_CAMOUFOX_RELEASE);
    expect(fetcher.checkAsset(asset('156.0.1-beta.34'))).toBeNull();
  });
});
