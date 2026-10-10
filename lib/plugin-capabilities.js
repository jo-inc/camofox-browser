export function createVirtualDisplayRegistry(defaultFactory) {
  let provider = { name: 'core', factory: defaultFactory };

  return {
    register(pluginName, factory) {
      if (typeof factory !== 'function') {
        throw new TypeError(`virtual display provider for plugin "${pluginName}" must be a function`);
      }
      if (provider.name !== 'core') {
        const error = new Error(
          `virtual display provider conflict: "${provider.name}" already owns the capability; "${pluginName}" cannot also provide it`
        );
        error.code = 'plugin_capability_conflict';
        throw error;
      }
      provider = { name: pluginName, factory };
    },

    create() {
      return provider.factory();
    },

    get owner() {
      return provider.name;
    },
  };
}

/** Caps the fingerprint's screen at the Xvfb screen, so the browser window Camoufox sizes from it fits on the display. */
export function virtualDisplayScreen(display) {
  const args = display.xvfb_args;
  const [maxWidth, maxHeight] = args[args.indexOf('-screen') + 2].split('x').map(Number);
  return { maxWidth, maxHeight };
}
