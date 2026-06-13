/**
 * Per-session write queue — serializes updateSessionMessages calls for the
 * same session ID so concurrent HTTP requests don't overwrite each other.
 */
import { updateSessionMessages, loadSessionMessages, renameSession, sessionExists } from '../../history';
import type { SessionTokenStats } from '../../history';
import type { PersistedChatMessage } from '../../services/llm';

const sessionWriteQueues = new Map<number, Promise<void>>();

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
 */
export async function enqueueSessionWrite(
    sessionId: number,
    buildMessages: (currentMessages: PersistedChatMessage[]) => PersistedChatMessage[] | Promise<PersistedChatMessage[]>,
    tokenStats?: SessionTokenStats | null,
): Promise<void> {
    const prev = sessionWriteQueues.get(sessionId) ?? Promise.resolve();

    // Serialize: wait for the previous write, then read fresh DB state,
    // let the caller produce the new list, and persist it.
    const next = prev.then(async () => {
        if (!sessionExists(sessionId)) {
            console.warn(`[sessionWriteQueue] Skipping write for deleted session ${sessionId}`);
            return;
        }
        const currentMessages = loadSessionMessages(sessionId);
        const newMessages = await buildMessages(currentMessages);
        updateSessionMessages(sessionId, newMessages, tokenStats);
    }).catch((err) => {
        // Prevent an unhandled rejection from breaking the queue.
        // A failed write should not block subsequent writes for this session.
        console.error(
            `[sessionWriteQueue] Failed to write messages for session ${sessionId}:`,
            err instanceof Error ? err.message : String(err),
        );
    });

    sessionWriteQueues.set(sessionId, next);
    return next.finally(() => {
        if (sessionWriteQueues.get(sessionId) === next) {
            sessionWriteQueues.delete(sessionId);
        }
    });
}

/**
 * Per-session rename queue — serializes renameSession calls for the same
 * session ID so concurrent /title requests don't race on SQL writes.
 */
const sessionRenameQueues = new Map<number, Promise<void>>();

export async function enqueueSessionRename(
    sessionId: number,
    newName: string,
): Promise<void> {
    const prev = sessionRenameQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
        renameSession(sessionId, newName);
    }).catch((err) => {
        console.error(
            `[sessionWriteQueue] Failed to rename session ${sessionId}:`,
            err instanceof Error ? err.message : String(err),
        );
    });
    sessionRenameQueues.set(sessionId, next);
    return next.finally(() => {
        if (sessionRenameQueues.get(sessionId) === next) {
            sessionRenameQueues.delete(sessionId);
        }
    });
}
