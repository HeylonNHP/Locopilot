import type { PersistedChatMessage } from '../../services/llm';

import {
  loadSessionMessages,
  renameSession,
  sessionExists,
  type SessionTokenStats,
  updateSessionMessages,
} from '../../history';

const sessionWriteQueues = new Map<number, Promise<void>>();
const sessionRenameQueues = new Map<number, Promise<void>>();

/**
 * Queue a session-messages write for the given session.  All writes to the
 * same session ID execute sequentially (in FIFO order) regardless of which
 * HTTP request initiated them.
 *
 * Instead of accepting a static message array (which may be stale by the time
 * the queued callback executes), callers pass a **reducer function** that
 * receives the *current* messages freshly read from the database and returns
 * the desired new message list.  This prevents the last-writer-wins race
 * where two concurrent requests for the same session could overwrite each
 * other's messages.
 *
 * Errors are propagated to the caller. The queue itself stays alive so a
 * failed write does not block subsequent writes for the same session.
 */
export async function enqueueSessionWrite(
  sessionId: number,
  buildMessages: (
    currentMessages: PersistedChatMessage[]
  ) => PersistedChatMessage[] | Promise<PersistedChatMessage[]>,
  tokenStats?: SessionTokenStats | null
): Promise<void> {
  const prev = sessionWriteQueues.get(sessionId) ?? Promise.resolve();

  // Serialize: wait for the previous write, then read fresh DB state,
  // let the caller produce the new list, and persist it.
  const work = prev.then(async () => {
    if (!sessionExists(sessionId)) {
      console.warn(`[sessionWriteQueue] Skipping write for deleted session ${sessionId}`);
      return;
    }
    const currentMessages = loadSessionMessages(sessionId);
    const newMessages = await buildMessages(currentMessages);
    updateSessionMessages(sessionId, newMessages, tokenStats);
  });

  // Keep the queue alive on error so later writes are not blocked, but
  // surface the failure to the caller by returning the rejecting promise.
  const queued = work.catch(() => {});
  sessionWriteQueues.set(sessionId, queued);
  return work.finally(() => {
    if (sessionWriteQueues.get(sessionId) === queued) {
      sessionWriteQueues.delete(sessionId);
    }
  });
}

/**
 * Per-session rename queue — serializes renameSession calls for the same
 * session ID so concurrent /title requests don't race on SQL writes.
 *
 * Errors are propagated to the caller.
 */
export async function enqueueSessionRename(sessionId: number, newName: string): Promise<void> {
  const prev = sessionRenameQueues.get(sessionId) ?? Promise.resolve();
  const work = prev.then(async () => {
    renameSession(sessionId, newName);
  });

  const queued = work.catch(() => {});
  sessionRenameQueues.set(sessionId, queued);
  return work.finally(() => {
    if (sessionRenameQueues.get(sessionId) === queued) {
      sessionRenameQueues.delete(sessionId);
    }
  });
}
