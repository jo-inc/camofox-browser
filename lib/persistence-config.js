function resolvePersistenceIndexedDB(pluginConfig = {}) {
  return pluginConfig.indexedDB === true;
}

export { resolvePersistenceIndexedDB };
