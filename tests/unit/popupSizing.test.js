/**
 * Unit tests for the headed-popup resize decision (issue #7742).
 *
 * A window.open() popup in headed (virtual display / VNC / desktop) mode inherits
 * a tiny native window, leaving Google Identity Services ux_mode=popup OAuth
 * unusable. We nudge ONLY implausibly-small popups in headed mode -- and only
 * when the viewport transport shim is installed so the resize can actually work.
 *
 * Main browser contexts stay viewport:null (stealth); these tests pin the exact
 * gating so a usable-size popup or a headless/no-shim case is never touched.
 */

import {
  shouldResizePopup,
  MIN_USABLE_POPUP,
  POPUP_RESIZE_TARGET,
} from '../../lib/popup-sizing.js';

describe('shouldResizePopup gating (#7742)', () => {
  const tiny = { width: 300, height: 300 };   // below both minimums
  const large = { width: 1280, height: 720 }; // comfortably above minimums

  test('headless mode never resizes, even a tiny popup', () => {
    expect(shouldResizePopup({ headed: false, shimInstalled: true, ...tiny })).toBe(false);
  });

  test('shim-not-installed never resizes, even headed + tiny', () => {
    expect(shouldResizePopup({ headed: true, shimInstalled: false, ...tiny })).toBe(false);
  });

  test('already-large popup is not resized (preserves natural size / stealth)', () => {
    expect(shouldResizePopup({ headed: true, shimInstalled: true, ...large })).toBe(false);
  });

  test('tiny popup in headed + shim mode IS resized', () => {
    expect(shouldResizePopup({ headed: true, shimInstalled: true, ...tiny })).toBe(true);
  });

  test('resizes when only width is below the minimum', () => {
    expect(shouldResizePopup({
      headed: true, shimInstalled: true,
      width: MIN_USABLE_POPUP.width - 1, height: MIN_USABLE_POPUP.height + 50,
    })).toBe(true);
  });

  test('resizes when only height is below the minimum', () => {
    expect(shouldResizePopup({
      headed: true, shimInstalled: true,
      width: MIN_USABLE_POPUP.width + 50, height: MIN_USABLE_POPUP.height - 1,
    })).toBe(true);
  });

  test('a popup exactly at the minimum is usable and not resized', () => {
    expect(shouldResizePopup({
      headed: true, shimInstalled: true,
      width: MIN_USABLE_POPUP.width, height: MIN_USABLE_POPUP.height,
    })).toBe(false);
  });

  test('non-finite / unmeasurable size never resizes (no guessing)', () => {
    expect(shouldResizePopup({ headed: true, shimInstalled: true, width: NaN, height: NaN })).toBe(false);
    expect(shouldResizePopup({ headed: true, shimInstalled: true, width: 300, height: undefined })).toBe(false);
    expect(shouldResizePopup({ headed: true, shimInstalled: true, width: null, height: 300 })).toBe(false);
  });

  test('resize target is modest -- usable but well short of a full main window', () => {
    // Guards against anyone bumping the target back up to the full 1280x720.
    expect(POPUP_RESIZE_TARGET.width).toBeGreaterThanOrEqual(MIN_USABLE_POPUP.width);
    expect(POPUP_RESIZE_TARGET.height).toBeGreaterThanOrEqual(MIN_USABLE_POPUP.height);
    expect(POPUP_RESIZE_TARGET.width).toBeLessThan(1280);
    expect(POPUP_RESIZE_TARGET.height).toBeLessThanOrEqual(720);
  });
});
