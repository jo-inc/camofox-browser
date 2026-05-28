// Decides whether the camofox launch should be ephemeral (default
// firefox.launch) or persistent (firefox.launchPersistentContext against
// a cloned user profile). Pure function for testability.

export function chooseLaunch(env) {
  const raw = env.CAMOFOX_USER_DATA_DIR;
  if (!raw) return 'launch';
  if (!raw.startsWith('/')) {
    throw new Error(`CAMOFOX_USER_DATA_DIR must start with /, got: ${raw}`);
  }
  if (!raw.startsWith('/tmp/firefox-borrow-')) {
    throw new Error(
      `CAMOFOX_USER_DATA_DIR must start with /tmp/firefox-borrow-, got: ${raw}`
    );
  }
  return 'persistent';
}
