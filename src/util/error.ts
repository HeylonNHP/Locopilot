/**
 * Error helpers shared across server-side modules.
 *
 * `AbortError` is produced by `DOMException('Aborted', 'AbortError')` in many
 * places, and the literal string `'Unknown error'` is the most common fallback
 * for `catch { ... }` blocks. Centralising both makes consumer code shorter
 * and removes the silent typo risk from copy-pasted incantations.
 */

/**
 * Canonical `DOMException.name` value used to signal a cancelled/aborted
 * operation. Matches the value thrown by `AbortController.abort()` (which
 * produces `DOMException('This operation was aborted', 'AbortError')`).
 */
export const ABORT_ERROR_NAME = 'AbortError';

/** Common fallback message when an `Error.message` is missing or unusable. */
export const UNKNOWN_ERROR_MESSAGE = 'Unknown error';

/**
 * Type guard that returns `true` for any thrown value matching the standard
 * `AbortError` shape — either the DOMException name form or the common
 * `Error('The user aborted a request')` substring thrown by `node:fetch`.
 */
export function isAbortError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err === 'object' && 'name' in err) {
    return (err as { name?: unknown }).name === ABORT_ERROR_NAME;
  }
  if (err instanceof Error) {
    return err.message.toLowerCase().includes('abort');
  }
  return false;
}

/**
 * Best-effort stringification of an unknown thrown value. Falls back to
 * `UNKNOWN_ERROR_MESSAGE` for non-Error values, and uses the original Error's
 * `.message` otherwise. Useful for `catch (err)` blocks that need to feed a
 * user-facing string.
 */
export function describeError(err: unknown, fallback: string = UNKNOWN_ERROR_MESSAGE): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string') return err;
  return fallback;
}
