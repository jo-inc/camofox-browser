// Recreating a context for every probe opens a top-level window on real displays.
export function createHealthProbe({ newContext, gotoTimeoutMs = 5000 } = {}) {
  let context = null;
  let page = null;

  function pageUsable() {
    try {
      return !!page && !page.isClosed();
    } catch {
      return false;
    }
  }

  async function teardown() {
    const [p, c] = [page, context];
    page = null;
    context = null;
    if (p) await Promise.resolve(p.close()).catch(() => {});
    if (c) await Promise.resolve(c.close()).catch(() => {});
  }

  async function ensure() {
    if (pageUsable()) return;
    await teardown();
    context = await newContext();
    page = await context.newPage();
  }

  return {
    async probe() {
      try {
        await ensure();
        await page.goto('about:blank', { timeout: gotoTimeoutMs });
        return;
      } catch {}
      await teardown();
      await ensure();
      await page.goto('about:blank', { timeout: gotoTimeoutMs });
    },

    dispose: teardown,
  };
}
