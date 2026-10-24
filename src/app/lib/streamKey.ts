/**
 * The key a chat turn is registered under in `abortControllersRef` and in the
 * store's `streamingSessions` set.
 *
 * A turn started from a brand-new chat has no session id yet — the server
 * assigns one and reports it back in the first `session_created` event. Until
 * then the turn is keyed `NEW_SESSION_KEY`, and the stream migrates the key
 * once the real id arrives (`useChatStream`). Everything that reads those
 * registries must derive the key from here so writers and readers cannot
 * drift: `handleStop` used to bail on a `null` session id and therefore
 * silently ignored the Stop button for exactly those turns.
 */

/** Placeholder key for a turn whose session has not been created yet. */
export const NEW_SESSION_KEY = -1;

/** Resolve the registry key for a turn, normalising "no session yet". */
export function streamKeyFor(sessionId: number | null | undefined): number {
  return sessionId ?? NEW_SESSION_KEY;
}
