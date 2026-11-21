import { describe, expect, test } from '@jest/globals';
import { OS_NAME } from 'camoufox';
import {
  BUNDLED_CAMOUFOX_RELEASE,
  CompatibleCamoufoxFetcher,
  isBundledCamoufoxInstalled,
} from '../../lib/camoufox-download.js';

describe('bundled Camoufox release selection', () => {
  test('accepts the pinned binary and rejects other releases', () => {
    const fetcher = new CompatibleCamoufoxFetcher();
    const asset = (release) => ({
      name: `camoufox-${release}-${OS_NAME}.${fetcher.arch}.zip`,
      browser_download_url: `https://example.invalid/${release}`,
    });

    expect(fetcher.checkAsset(asset(BUNDLED_CAMOUFOX_RELEASE))?.[0].fullString)
      .toBe(BUNDLED_CAMOUFOX_RELEASE);
    expect(fetcher.checkAsset(asset('152.0.4-beta.30'))).toBeNull();
    expect(fetcher.checkAsset(asset('158.0.1-beta.42'))).toBeNull();
  });

  test('detects the pinned release among installed browsers', () => {
    const installed = (...releases) => () => releases.map((fullString) => ({ version: { fullString } }));

    expect(isBundledCamoufoxInstalled({ installed: installed() })).toBe(false);
    expect(isBundledCamoufoxInstalled({ installed: installed('152.0.4-beta.30') })).toBe(false);
    expect(isBundledCamoufoxInstalled({
      installed: installed('152.0.4-beta.30', BUNDLED_CAMOUFOX_RELEASE),
    })).toBe(true);
  });
});
