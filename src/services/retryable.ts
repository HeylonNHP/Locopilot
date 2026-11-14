/**
 * retryable.ts
 *
 * Shared classification of TRANSIENT provider failures, plus the abort-aware
 * backoff sleep that every retry loop in the app needs.
 *
 * WHY THIS FILE EXISTS. The classifier used to live in
 * `src/app/api/chat/sseStream.ts` — the chat ROUTE's module. `src/tools/`
 * must not import from `src/app/api/`: the route owns the HTTP lifecycle
 * (request context, SSE frames, session persistence) and the tool layer has
 * to stay independent of it. But the sub-agent's own tool loop needs the SAME
 * verdict — "is this failure worth re-issuing the identical request?" — and
 * the main chat loop and the sub-agent must never drift apart on what counts
 * as transient, so the classifier moved here, beside the other shared
 * services. `sseStream.ts` re-exports it, so the route module's public
 * surface is unchanged.
 *
 * The classification is deliberately duck-typed: any object carrying a
 * NUMERIC `.status` is checked, so `OpenAI.APIError` (which is NOT an axios
 * error) is recognised, as is a fetch-style error with a status attached.
 */

import axios from 'axios';

import { DEFAULT_RETRYABLE_STATUSES } from '@/services/configDefaults';

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

/**
 * The HTTP status carried by an error, when it has one.
 *
 * `OpenAI.APIError` exposes it as `.status`; an axios error keeps it on
 * `.response.status`. Used to tell the user WHICH failure happened (a 500
 * gateway error reads very differently from a 429) without having to parse
 * the message text.
 */
export function retryableErrorStatus(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return null;
}

/**
 * Read one response header from an error, whichever shape carries it: the
 * OpenAI SDK's `err.headers` (a `Headers` with `.get`), or axios's
 * `err.response.headers` (an `AxiosHeaders` with `.get`, or a plain object).
 */
function readErrorHeader(err: unknown, name: string): string | null {
  if (!err || typeof err !== 'object') return null;
  const candidates = [
    (err as { headers?: unknown }).headers,
    (err as { response?: { headers?: unknown } }).response?.headers,
  ];
  for (const headers of candidates) {
    if (!headers || typeof headers !== 'object') continue;
    const get = (headers as { get?: unknown }).get;
    if (typeof get === 'function') {
      const value = (get as (key: string) => unknown).call(headers, name);
      if (typeof value === 'string' && value.length > 0) return value;
      continue;
    }
    const value = (headers as Record<string, unknown>)[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * A server-supplied retry delay in milliseconds, capped at `maxDelayMs`, or
 * null when the error carries none. Reads `retry-after-ms` (Cloudflare-style
 * milliseconds) and `retry-after` in its two forms: integer seconds and an
 * HTTP-date.
 */
export function getRetryAfterDelayMs(err: unknown, maxDelayMs: number): number | null {
  const msHeader = readErrorHeader(err, 'retry-after-ms');
  if (msHeader) {
    const n = Number(msHeader);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, maxDelayMs);
  }

  const header = readErrorHeader(err, 'retry-after');
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), maxDelayMs);
  }

  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), maxDelayMs);
  }
  return null;
}

/**
 * Sleep for `ms`, but wake up immediately when `signal` aborts.
 *
 * Resolves `true` when the wait was cut short by an abort and `false` when
 * the full delay elapsed. The abort listener is removed on the normal path,
 * so a long-lived signal does not accumulate one listener per retry.
 *
 * This is the shared backoff primitive for the retry loops that must not
 * outlive the request they belong to: the chat route's inline
 * `setTimeout` + abort-listener pair and the sub-agent's transient-retry
 * branch both need the same semantics, and both must be interruptible within
 * milliseconds of the user's interrupt.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve(true);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
