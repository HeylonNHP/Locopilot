/**
 * Per-session write queue — serializes updateSessionMessages calls for the
 * same session ID so concurrent HTTP requests don't overwrite each other.
 */
import { updateSessionMessages } from '../../history';
import type { SessionTokenStats } from '../../history';
import type { ChatMessage } from '../../services/llm';

const sessionWriteQueues = new Map<number, Promise<void>>();

/**
 * Queue a session-messages write for the given session.  All writes to the
 * same session ID execute sequentially (in FIFO order) regardless of which
 * HTTP request initiated them.
 */
export async function enqueueSessionWrite(
    sessionId: number,
    messages: ChatMessage[],
    tokenStats?: SessionTokenStats | null,
): Promise<void> {
    const prev = sessionWriteQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(
        () => { updateSessionMessages(sessionId, messages, tokenStats); },
        () => { updateSessionMessages(sessionId, messages, tokenStats); }, // Also run if the previous write failed.
    );
    sessionWriteQueues.set(sessionId, next);
    return next.finally(() => {
        if (sessionWriteQueues.get(sessionId) === next) {
            sessionWriteQueues.delete(sessionId);
        }
    });
}
