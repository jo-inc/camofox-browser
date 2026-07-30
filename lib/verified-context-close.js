export async function closeContextVerified(context) {
  try {
    await context.close();
  } catch (error) {
    try {
      context.pages();
    } catch {
      return;
    }
    throw error;
  }
}

export function deleteSessionIfCurrent(registry, key, session) {
  if (registry.get(key) !== session) {
    throw Object.assign(new Error('Session changed while its prior context was closing'), {
      statusCode: 409,
      code: 'session_replaced_during_close',
    });
  }
  registry.delete(key);
}
