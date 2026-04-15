async function coalesceInflight(map, key, factory) {
  const existing = map.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await factory();
    } finally {
      map.delete(key);
    }
  })();
  map.set(key, promise);
  return promise;
}

export { coalesceInflight };
