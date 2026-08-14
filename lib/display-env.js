// lib/display-env.js -- Launch environment for the browser under Xvfb.
//
// Firefox picks its display backend BEFORE honoring DISPLAY: if
// WAYLAND_DISPLAY is present (and MOZ_ENABLE_WAYLAND=1, which Wayland
// desktops like Hyprland/omarchy export session-wide), the Wayland backend
// wins, DISPLAY is ignored, and the browser opens a real window on the
// user's compositor -- tiling into their active workspace and kicking apps
// out of fullscreen -- while the Xvfb display renders for nobody.
//
// Playwright REPLACES the child environment with the `env` launch option
// when one is provided (playwright-core browserType: `options.env ? ... :
// process.env`), so deleting the Wayland variables from a copy here truly
// removes them from the browser process without touching the desktop
// session. camoufox-js then sets DISPLAY to the virtual display on this
// same object.

/**
 * Build a browser launch environment pinned to the X11 backend, so the
 * window can only ever appear on the virtual (Xvfb) display.
 *
 * @param {NodeJS.ProcessEnv} [baseEnv] - Environment to copy (default process.env).
 * @returns {NodeJS.ProcessEnv} New object; the input is never mutated.
 */
export function x11PinnedEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  // With WAYLAND_DISPLAY set, the Wayland backend outranks DISPLAY even when
  // MOZ_ENABLE_WAYLAND=0 is also set on some Firefox builds -- removal is the
  // only reliable off switch.
  delete env.WAYLAND_DISPLAY;
  delete env.XDG_SESSION_TYPE;
  env.MOZ_ENABLE_WAYLAND = '0';
  env.GDK_BACKEND = 'x11';
  return env;
}
