/**
 * Popup sizing policy for headed (virtual display / VNC / desktop window) mode.
 *
 * Background: a window.open() popup in headed mode inherits a tiny native window
 * from the OS window manager. That leaves Google Identity Services ux_mode=popup
 * consent (LinkedIn/GitHub/StackOverflow "Sign in with Google") too small to
 * use. We nudge ONLY such implausibly-small popups to a usable size.
 *
 * Stealth note: main browser contexts stay viewport:null (an anti-detection
 * choice -- a fixed round viewport is a fingerprint tell). Only cramped popups
 * in headed mode are touched; usable-size popups keep their natural size.
 */

// Minimum size below which a headed popup is considered implausibly small and
// unusable for Google's account-picker/consent card. Compared against the
// popup's width AND height -- if EITHER is under the minimum, the popup is
// resized.
export const MIN_USABLE_POPUP = { width: 500, height: 600 };

// Target size we nudge an implausibly-small headed popup to. Modest on purpose:
// large enough for Google's account-picker/consent card, but well short of the
// full 1280x720 main window so the stealth posture is preserved.
export const POPUP_RESIZE_TARGET = { width: 640, height: 700 };

/**
 * Pure decision predicate: should a freshly-opened popup be resized?
 *
 * Returns true only when ALL of:
 *   - headed:        browser launched headed (headless popups are never resized)
 *   - shimInstalled: viewport transport shim is live, so setViewportSize works
 *   - small:         measured width < MIN or height < MIN (usable popups untouched)
 *
 * If width/height are not finite (could not be measured) we do NOT resize --
 * better to leave a popup on its natural size than guess.
 */
export function shouldResizePopup({ headed, shimInstalled, width, height }, min = MIN_USABLE_POPUP) {
  if (!headed || !shimInstalled) return false;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return width < min.width || height < min.height;
}
