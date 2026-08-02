/**
 * SSE (Server-Sent Events) stream infrastructure for the chat API route.
 *
 * Provides a factory for creating SSE event emitters with keepalive support,
 * and pure helper functions for classifying retryable errors.
 */

import axios from 'axios';

import type { SseEventPayloadMap } from '@/types/sse';

/**
 * Create an SSE event emitter bound to a ReadableStream controller.
 * Returns sendEvent, startKeepalive, stopKeepalive, and the encoder.
 */
export function createSseStream(controller: ReadableStreamDefaultController) {
  const encoder = new TextEncoder();
  let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  function sendEvent<N extends keyof SseEventPayloadMap>(
    event: N,
    data: SseEventPayloadMap[N]
  ): void {
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
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
    }, 5000);
  }

  function stopKeepalive(): void {
    if (keepaliveInterval) {
      clearInterval(keepaliveInterval);
      keepaliveInterval = null;
    }
  }

  return { sendEvent, startKeepalive, stopKeepalive, encoder };
}

/** HTTP status codes that warrant a retry. */
export function isRetryableStatus(value: number): value is 429 | 502 | 503 | 504 {
  return value === 429 || value === 502 || value === 503 || value === 504;
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
