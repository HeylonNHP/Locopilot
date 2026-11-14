/**
 * Retry an async request that fails with a TRANSIENT error (429, 5xx, a
 * dropped socket), with exponential backoff, jitter and `Retry-After`.
 *
 * It is the retry loop of a caller that has no adapter-level retry of its own
 * (the Ollama adapter has none; the OpenAI-compatible one does, see
 * `withRetryAround`). The classification is the app's shared one
 * (`isRetryableError`), so a caller cannot drift from what counts as transient.
 *
 * Pre-stream semantics are the caller's business: wrap the WHOLE request, and
 * make sure a retry cannot duplicate a visible effect.
 */

import {
  abortableSleep,
  getRetryAfterDelayMs,
  isRetryableError,
  retryableErrorStatus,
} from '@/services/retryable';

export interface TransientRetryPolicy {
  /** Total attempts, the first included (1 = no retry). */
  maxAttempts: number;
  baseDelayMs: number;
  /** Ceiling on one sleep; also clamps a server `Retry-After`. */
  maxDelayMs: number;
}

export interface TransientRetryOptions extends TransientRetryPolicy {
  signal?: AbortSignal | undefined;
  /** Replaceable for tests; defaults to `Math.random`. */
  random?: () => number;
  /** Replaceable for tests; resolves true when the sleep was cut short by an abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  /** Called before each sleep, so the caller can log the retry. */
  onRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    status: number | null;
    error: unknown;
  }) => void;
}

/** ±25 % so a burst of simultaneous 429s does not retry in lockstep. */
const JITTER_SPREAD = 0.25;

/**
 * The delay before retry number `attempt` (1 = after the first failure):
 * the server's `Retry-After` when it sent one, otherwise the exponential
 * backoff with jitter. Never above `maxDelayMs`.
 */
export function computeRetryDelayMs(
  error: unknown,
  attempt: number,
  policy: TransientRetryPolicy,
  random: () => number = Math.random
): number {
  const serverHint = getRetryAfterDelayMs(error, policy.maxDelayMs);
  if (serverHint !== null) return serverHint;
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  const jitter = 1 - JITTER_SPREAD + random() * 2 * JITTER_SPREAD;
  return Math.min(Math.round(exponential * jitter), policy.maxDelayMs);
}

export async function retryOnTransientError<T>(
  task: (attempt: number) => Promise<T>,
  options: TransientRetryOptions
): Promise<T> {
  const { signal, maxAttempts, random, onRetry } = options;
  const sleep = options.sleep ?? abortableSleep;

  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw abortError(signal);
    try {
      return await task(attempt);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt >= maxAttempts || !isRetryableError(err)) throw err;

      const delayMs = computeRetryDelayMs(err, attempt, options, random);
      onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        status: retryableErrorStatus(err),
        error: err,
      });
      if (await sleep(delayMs, signal)) throw abortError(signal);
    }
  }
}

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}
