// Natural mouse movement (anti-bot).
// Mirrors bws's humanize approach: aim for a random point within the element
// bounds rather than teleporting to dead center, which is a bot tell that trips
// anti-bot systems (Taobao slider, Shopee verify). The eased, jittered path to
// that point is produced by Camoufox itself (launched with humanize: true, see
// server.js), which expands every page.mouse.move into a multi-segment human
// path -- stepping the move in JS as well would multiply that cost by the step
// count and blow the /click handler budget.

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
