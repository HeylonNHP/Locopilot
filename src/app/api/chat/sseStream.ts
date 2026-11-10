/**
 * SSE (Server-Sent Events) stream infrastructure for the chat API route.
 *
 * Provides a factory for creating SSE event emitters with keepalive support.
 *
 * The transient-failure classifier lives in `@/services/retryable` (shared
 * with the tool layer, which must not import from the route). It is
 * re-exported here so the route module's public surface is unchanged.
 */

import type { SseEventPayloadMap } from '@/types/sse';

import { SSE_KEEPALIVE_MS } from '@/constants';

/**
 * Identity stamped onto every frame of a turn.
 *
 * `streamId` names the turn, `sessionId` names the session the turn belongs
 * to (null until the server has created it), and `seq` counts frames within
 * the turn. The client used to have to infer all three — which session owns
 * this frame, which turn produced it — from its own bookkeeping, and got it
 * wrong often enough to ship two bug fixes. The server already knows, so it
 * says so.
 */
export interface SseFrameIdentity {
  streamId: string;
  sessionId: number | null;
  seq: number;
}

/**
 * Create an SSE event emitter bound to a ReadableStream controller.
 * Returns sendEvent, startKeepalive, stopKeepalive, and the encoder.
 *
 * `getIdentity` is called per frame so the session id can become known
 * mid-turn (a brand-new chat is only assigned its id once the first
 * `session_created` event is sent).
 */
export function createSseStream(
  controller: ReadableStreamDefaultController,
  getIdentity: () => { streamId: string; sessionId: number | null }
) {
  const encoder = new TextEncoder();
  let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  let seq = 0;

  function sendEvent<N extends keyof SseEventPayloadMap>(
    event: N,
    data: SseEventPayloadMap[N]
  ): void {
    seq += 1;
    const { streamId, sessionId } = getIdentity();
    // The event's own fields win over the envelope, so `session_created` —
    // whose payload is the id of the session that was just created — keeps
    // its value even if the identity has not caught up yet.
    const payload = { streamId, sessionId, seq, ...data };
    try {
      controller.enqueue(
        encoder.encode(
          `id: ${streamId}:${seq}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
        )
      );
    } catch {
      // Client disconnected — safe to ignore
    }
  }

  function startKeepalive(): void {
    if (keepaliveInterval) return;
    keepaliveInterval = setInterval(() => {
      try {
        controller.enqueue(encoder.encode(': \n\n'));
      } catch {
        // Client disconnected – ignore.
      }
    }, SSE_KEEPALIVE_MS);
  }

  function stopKeepalive(): void {
    if (keepaliveInterval) {
      clearInterval(keepaliveInterval);
      keepaliveInterval = null;
    }
  }

  return { sendEvent, startKeepalive, stopKeepalive, encoder };
}

export {
  hasRetryableMessage,
  isRetryableError,
  isRetryableNetworkCode,
  isRetryableStatus,
} from '@/services/retryable';
