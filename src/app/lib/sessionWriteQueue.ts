import type { PersistedChatMessage } from '@/services/llm';

import {
  loadSessionMessages,
  renameSession,
  sessionExists,
  type SessionTokenStats,
  updateSessionMessages,
} from '@/services/history';

const sessionWriteQueues = new Map<number, Promise<unknown>>();
const sessionRenameQueues = new Map<number, Promise<void>>();

async function enqueueSessionTask<T>(sessionId: number, task: () => Promise<T> | T): Promise<T> {
  const prev = sessionWriteQueues.get(sessionId) ?? Promise.resolve();
  const work = prev.then(task);
  const queued = work.catch(() => {});
  sessionWriteQueues.set(sessionId, queued);
  return work.finally(() => {
    if (sessionWriteQueues.get(sessionId) === queued) {
      sessionWriteQueues.delete(sessionId);
    }
  });
}

/**
 * Queue an arbitrary session operation alongside message writes.
 * Operations run FIFO with chat, compaction, and other session mutations.
 */
export function enqueueSessionOperation<T>(
  sessionId: number,
  operation: () => Promise<T> | T
): Promise<T> {
  return enqueueSessionTask(sessionId, operation);
}

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
  return enqueueSessionTask(sessionId, async () => {
    if (!sessionExists(sessionId)) {
      throw new Error(`Session ${sessionId} no longer exists; skipping write.`);
    }
    const currentMessages = loadSessionMessages(sessionId);
    const newMessages = await buildMessages(currentMessages);
    updateSessionMessages(sessionId, newMessages, tokenStats);
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
