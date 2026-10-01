const DRAG_BUTTONS = new Set(['left', 'right', 'middle']);
const DRAG_REQUEST_KEYS = new Set(['userId', 'start', 'end', 'steps', 'durationMs', 'button']);
const DRAG_POINT_KEYS = new Set(['x', 'y']);

export const DRAG_DEFAULT_STEPS = 12;
export const DRAG_MIN_STEPS = 1;
export const DRAG_MAX_STEPS = 24;
export const DRAG_DEFAULT_DURATION_MS = 800;
export const DRAG_MIN_DURATION_MS = 1;
export const DRAG_MAX_DURATION_MS = 5_000;

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function validPoint(point) {
  return point && typeof point === 'object' &&
    Number.isFinite(point.x) && Number.isFinite(point.y);
}

function invalid(error) {
  return { ok: false, error };
}

/**
 * Validate and normalize the JSON contract for an atomic trusted drag.
 *
 * Keeping this pure makes the route's strict input contract testable without
 * importing server.js (which starts the browser server as a side effect).
 */
export function validateTrustedDragRequest(body) {
  const request = body && typeof body === 'object' ? body : {};
  if (!hasOnlyKeys(request, DRAG_REQUEST_KEYS)) {
    return invalid('unknown drag request field');
  }

  const { userId, start, end } = request;

  if (typeof userId !== 'string' || userId.trim() === '') {
    return invalid('userId required');
  }
  if (!validPoint(start) || !validPoint(end)) {
    return invalid('start and end coordinates with finite x and y required');
  }
  if (!hasOnlyKeys(start, DRAG_POINT_KEYS) || !hasOnlyKeys(end, DRAG_POINT_KEYS)) {
    return invalid('start and end may only contain x and y');
  }

  const steps = request.steps === undefined ? DRAG_DEFAULT_STEPS : request.steps;
  if (!Number.isInteger(steps) || steps < DRAG_MIN_STEPS || steps > DRAG_MAX_STEPS) {
    return invalid(`steps must be an integer between ${DRAG_MIN_STEPS} and ${DRAG_MAX_STEPS}`);
  }

  const durationMs = request.durationMs === undefined ? DRAG_DEFAULT_DURATION_MS : request.durationMs;
  if (!Number.isInteger(durationMs) || durationMs < DRAG_MIN_DURATION_MS || durationMs > DRAG_MAX_DURATION_MS) {
    return invalid(`durationMs must be an integer between ${DRAG_MIN_DURATION_MS} and ${DRAG_MAX_DURATION_MS}`);
  }

  const button = request.button === undefined ? 'left' : request.button;
  if (!DRAG_BUTTONS.has(button)) {
    return invalid('button must be one of: left, right, middle');
  }

  return {
    ok: true,
    value: {
      userId: userId.trim(),
      start: { x: start.x, y: start.y },
      end: { x: end.x, y: end.y },
      steps,
      durationMs,
      button,
    },
  };
}

/**
 * Keep the gesture timeout below the tab-lock queue timeout so a concurrent
 * request cannot time out first and tear down the tab while the drag runs.
 */
export function trustedDragTimeoutMs({ steps, durationMs }, handlerTimeoutMs, lockTimeoutMs) {
  const gestureBudgetMs = durationMs + (steps + 3) * 1000;
  return Math.min(lockTimeoutMs - 1000, Math.max(handlerTimeoutMs, gestureBudgetMs));
}

/**
 * Dispatch one trusted, low-level mouse drag through Playwright's mouse API.
 *
 * `sleep` is injectable for deterministic unit tests. In production the
 * default timer spaces the interpolated moves so their cumulative delay is
 * exactly durationMs (subject to the host scheduler's timer resolution).
 */
export async function runTrustedDrag(page, { start, end, steps, durationMs, button }, sleep) {
  const wait = sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  await page.mouse.move(start.x, start.y);

  let pressed = false;
  try {
    await page.mouse.down({ button });
    pressed = true;

    let elapsed = 0;
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      const nextElapsed = Math.round(durationMs * progress);
      const delay = nextElapsed - elapsed;
      if (delay > 0) await wait(delay);
      await page.mouse.move(
        start.x + (end.x - start.x) * progress,
        start.y + (end.y - start.y) * progress,
      );
      elapsed = nextElapsed;
    }

    return { ok: true, start, end, steps, durationMs, button };
  } finally {
    if (pressed) await page.mouse.up({ button });
  }
}
