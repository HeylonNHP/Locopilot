/**
 * SSE (Server-Sent Events) stream infrastructure for the chat API route.
 *
 * Provides a factory for creating SSE event emitters with keepalive support,
 * and pure helper functions for classifying retryable errors.
 */

import axios from 'axios';

import type { SseEventPayloadMap } from '@/types/sse';

import { SSE_KEEPALIVE_MS } from '@/constants';
import { DEFAULT_RETRYABLE_STATUSES } from '@/services/configDefaults';

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

/** HTTP status codes that warrant a retry. Derived from `DEFAULT_RETRYABLE_STATUSES`. */
export function isRetryableStatus(value: number): boolean {
  return (DEFAULT_RETRYABLE_STATUSES as readonly number[]).includes(value);
}

/** Node.js network error codes that warrant a retry. */
export function isRetryableNetworkCode(
  value: string
): value is 'ECONNRESET' | 'ETIMEDOUT' | 'EPIPE' {
  return value === 'ECONNRESET' || value === 'ETIMEDOUT' || value === 'EPIPE';
}

/** Error message substrings that indicate a transient network failure. */
export function hasRetryableMessage(value: string): boolean {
  return value.includes('fetch failed') || value.includes('network timeout');
}

/**
 * Determine whether an error is transient and should be retried.
 * Handles axios HTTP errors, Node.js network error codes, generic
 * fetch/network failure messages, and OpenAI SDK errors (which carry
 * `.status` directly without being axios errors).
 */
export function isRetryableError(err: unknown): boolean {
  // Duck-type the OpenAI SDK shape first: `OpenAI.APIError` exposes a
  // numeric `status` but is NOT an axios error, so the `axios.isAxiosError`
  // branch below would miss every status from the openai-compatible
  // adapter. Any object with a numeric `status` is checked here so the
  // classifier also covers fetch-style errors with an attached status.
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number' &&
    isRetryableStatus((err as { status: number }).status)
  ) {
    return true;
  }

  // axios-style HTTP errors
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (typeof status === 'number' && isRetryableStatus(status)) {
      return true;
    }
  }

  // axios / Node.js network-level error codes
  if (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    isRetryableNetworkCode(err.code)
  ) {
    return true;
  }

  // generic fetch/network failures
  if (err instanceof Error && hasRetryableMessage(err.message)) {
    return true;
  }

  return false;
}
