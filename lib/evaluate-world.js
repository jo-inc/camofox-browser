// Since Camoufox 152.0.4-beta.30, Juggler's default world is an Xray sandbox: the page's DOM is shared, but the
// page's own JS state is not, so `window.someAppGlobal` reads undefined. A script reaches the page's world only
// through Camoufox's `mw:` prefix, and only when the browser was launched with main_world_eval.
// /evaluate and /init-script callers read and hook page state, as they could before beta.30, so they run in the main
// world unless they ask for the isolated one. The server's own page.evaluate() calls send no prefix and stay isolated.
export const MAIN_WORLD_PREFIX = 'mw:';
export const EVALUATE_WORLDS = Object.freeze(['main', 'isolated']);

export function evaluateWorldError(world) {
  if (world === undefined || EVALUATE_WORLDS.includes(world)) return null;
  return `world must be one of: ${EVALUATE_WORLDS.join(', ')}`;
}

export function sourceForWorld(source, world = 'main') {
  if (world !== 'main' || source.startsWith(MAIN_WORLD_PREFIX)) return source;
  return MAIN_WORLD_PREFIX + source;
}
