// A headed browser (CAMOFOX_INTERACTIVE=desktop) on a Wayland desktop that is not painting, for example a locked
// screen, never settles page.mouse.wheel: it took 20-30 s, then the route's action timeout returned a 500.
// scrollBy returns at once either way. Headless is unaffected.
export function scrollDeltas(direction, amount) {
  const isVertical = direction === 'up' || direction === 'down';
  const delta = (direction === 'up' || direction === 'left') ? -amount : amount;
  return isVertical ? [0, delta] : [delta, 0];
}

export async function scrollPage(page, direction, amount, { wheelTimeoutMs, log } = {}) {
  const [dx, dy] = scrollDeltas(direction, amount);
  const wheel = Promise.resolve(page.mouse.wheel(dx, dy));
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(true), wheelTimeoutMs); });
  try {
    if (!(await Promise.race([wheel.then(() => false), timedOut]))) return 'wheel';
  } finally {
    clearTimeout(timer);
  }
  wheel.catch(() => {});   // the abandoned wheel may still reject after the tab is gone
  if (log) log('warn', 'wheel scroll did not settle, scrolling the window instead', { wheelTimeoutMs, direction, amount });
  await page.evaluate(([x, y]) => window.scrollBy(x, y), [dx, dy]);
  return 'scrollBy';
}
