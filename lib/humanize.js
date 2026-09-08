// Natural mouse movement (anti-bot).
// Mirrors bws's humanize approach: a random point within the element bounds and
// a multi-step jittered path with human-variable delays. A single teleport to
// dead-center plus fixed 50ms waits is a bot tell that trips anti-bot systems
// (Taobao slider, Shopee verify).

export function rand(min, max) {
  return min + Math.random() * (max - min);
}

// Pick a random point inside a bounding box, padded away from the edges.
export function randomPointInBox(box, padFrac = 0.2) {
  const padX = Math.min(box.width * padFrac, box.width * 0.4);
  const padY = Math.min(box.height * padFrac, box.height * 0.4);
  return {
    x: box.x + padX + Math.random() * (box.width - 2 * padX),
    y: box.y + padY + Math.random() * (box.height - 2 * padY)
  };
}

// Move the mouse from `from` to (tx, ty) along an eased, jittered multi-step
// path instead of a single teleport. Returns the landing position so the caller
// can persist the cursor per page (Playwright's Mouse exposes no position()).
export async function naturalMouseMove(page, from, tx, ty, steps = 8) {
  const sx = from?.x ?? 0, sy = from?.y ?? 0;
  const dx = tx - sx, dy = ty - sy;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 2);
    const px = sx + dx * ease + (Math.random() - 0.5) * 3;
    const py = sy + dy * ease + (Math.random() - 0.5) * 3;
    await page.mouse.move(px, py);
    await page.waitForTimeout(rand(8, 30));
  }
  await page.mouse.move(tx, ty); // land exactly on target
  return { x: tx, y: ty };
}
