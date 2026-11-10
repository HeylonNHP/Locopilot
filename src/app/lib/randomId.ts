/**
 * Generate a UUID v4 string that works in all browser contexts.
 *
 * `crypto.randomUUID()` is only available in secure contexts — it throws a
 * TypeError on plain HTTP, which is exactly how the app is reached over the
 * LAN (the dev server binds 0.0.0.0). This helper lives in its own module so
 * both the chat store and the composer can use it without importing each
 * other.
 */
export function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for non-secure contexts (plain HTTP) where
    // crypto.randomUUID() throws a TypeError.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replaceAll(/[xy]/g, (c) => {
      const r = Math.trunc(Math.random() * 16);
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}
