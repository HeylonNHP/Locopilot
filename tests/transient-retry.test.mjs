/**
 * Tests for the transient-retry helper (src/services/transientRetry.ts) and the
 * shared `Retry-After` parser it uses (`getRetryAfterDelayMs`,
 * src/services/retryable.ts).
 *
 * No network and no real sleeping: the helper takes its sleep and random
 * source as arguments.
 */

import { describe, expect, test } from '@jest/globals';

import { getRetryAfterDelayMs } from '../src/services/retryable.ts';
import { computeRetryDelayMs, retryOnTransientError } from '../src/services/transientRetry.ts';

const POLICY = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 16_000 };

function statusError(status, headers) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    status,
    ...(headers ? { headers } : {}),
  });
}

/** A fake sleep that records the delays it was asked for and never waits. */
function recordingSleep() {
  const delays = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
      return false;
    },
  };
}

describe('getRetryAfterDelayMs', () => {
  test('reads the OpenAI SDK shape (err.headers.get)', () => {
    const err = statusError(429, new Headers({ 'retry-after': '3' }));
    expect(getRetryAfterDelayMs(err, 16_000)).toBe(3000);
  });

  test('reads the axios shape (err.response.headers, a plain object)', () => {
    const err = Object.assign(new Error('x'), { response: { headers: { 'retry-after': '2' } } });
    expect(getRetryAfterDelayMs(err, 16_000)).toBe(2000);
  });

  test('reads retry-after-ms before retry-after', () => {
    const err = statusError(429, new Headers({ 'retry-after-ms': '250', 'retry-after': '9' }));
    expect(getRetryAfterDelayMs(err, 16_000)).toBe(250);
  });

  test('reads the HTTP-date form', () => {
    const when = new Date(Date.now() + 5000).toUTCString();
    const err = statusError(429, new Headers({ 'retry-after': when }));
    const ms = getRetryAfterDelayMs(err, 16_000);
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  test('caps the hint at the ceiling', () => {
    const err = statusError(429, new Headers({ 'retry-after': '600' }));
    expect(getRetryAfterDelayMs(err, 16_000)).toBe(16_000);
  });

  test.each([
    ['no headers', new Error('x')],
    ['an unparseable value', statusError(429, new Headers({ 'retry-after': 'soon' }))],
    ['a non-object', 'nope'],
    ['null', null],
  ])('returns null for %s', (_name, err) => {
    expect(getRetryAfterDelayMs(err, 16_000)).toBeNull();
  });
});

describe('computeRetryDelayMs', () => {
  test('doubles each retry, with no jitter at the midpoint of the random range', () => {
    const middle = () => 0.5;
    const delays = [1, 2, 3].map((n) => computeRetryDelayMs(new Error('x'), n, POLICY, middle));
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  test('jitter stays within ±25 %', () => {
    expect(computeRetryDelayMs(new Error('x'), 1, POLICY, () => 0)).toBe(750);
    expect(computeRetryDelayMs(new Error('x'), 1, POLICY, () => 1)).toBe(1250);
  });

  test('never exceeds the ceiling', () => {
    expect(computeRetryDelayMs(new Error('x'), 10, POLICY, () => 1)).toBe(16_000);
  });

  test('a server Retry-After wins over the backoff', () => {
    const err = statusError(429, new Headers({ 'retry-after': '7' }));
    expect(computeRetryDelayMs(err, 1, POLICY, () => 0.5)).toBe(7000);
  });
});

describe('retryOnTransientError', () => {
  test('returns the first success without sleeping', async () => {
    const { delays, sleep } = recordingSleep();
    await expect(retryOnTransientError(async () => 'ok', { ...POLICY, sleep })).resolves.toBe('ok');
    expect(delays).toEqual([]);
  });

  test('retries a 429 and returns the later success, passing the attempt number', async () => {
    const { delays, sleep } = recordingSleep();
    const seen = [];
    const result = await retryOnTransientError(
      async (attempt) => {
        seen.push(attempt);
        if (attempt < 3) throw statusError(429);
        return 'done';
      },
      { ...POLICY, sleep, random: () => 0.5 }
    );
    expect(result).toBe('done');
    expect(seen).toEqual([1, 2, 3]);
    expect(delays).toEqual([1000, 2000]);
  });

  test('stops after maxAttempts and throws the last error', async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    await expect(
      retryOnTransientError(
        async () => {
          calls += 1;
          throw statusError(503);
        },
        { ...POLICY, maxAttempts: 3, sleep }
      )
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
  });

  test('maxAttempts of 1 means no retry', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    await expect(
      retryOnTransientError(
        async () => {
          calls += 1;
          throw statusError(429);
        },
        { ...POLICY, maxAttempts: 1, sleep }
      )
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(1);
  });

  test.each([400, 401, 404])('does not retry a %i', async (status) => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    await expect(
      retryOnTransientError(
        async () => {
          calls += 1;
          throw statusError(status);
        },
        { ...POLICY, sleep }
      )
    ).rejects.toMatchObject({ status });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  test('honours Retry-After', async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    await retryOnTransientError(
      async () => {
        calls += 1;
        if (calls === 1) throw statusError(429, new Headers({ 'retry-after': '4' }));
        return 'ok';
      },
      { ...POLICY, sleep }
    );
    expect(delays).toEqual([4000]);
  });

  test('reports each retry through onRetry', async () => {
    const { sleep } = recordingSleep();
    const infos = [];
    let calls = 0;
    await retryOnTransientError(
      async () => {
        calls += 1;
        if (calls < 3) throw statusError(429);
        return 'ok';
      },
      { ...POLICY, sleep, random: () => 0.5, onRetry: (info) => infos.push(info) }
    );
    expect(
      infos.map(({ attempt, maxAttempts, delayMs, status }) => ({
        attempt,
        maxAttempts,
        delayMs,
        status,
      }))
    ).toEqual([
      { attempt: 1, maxAttempts: 4, delayMs: 1000, status: 429 },
      { attempt: 2, maxAttempts: 4, delayMs: 2000, status: 429 },
    ]);
  });

  test('an abort during the backoff sleep rejects and stops retrying', async () => {
    const controller = new AbortController();
    let calls = 0;
    const promise = retryOnTransientError(
      async () => {
        calls += 1;
        throw statusError(429);
      },
      {
        ...POLICY,
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
          return true;
        },
      }
    );
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  test('an already-aborted signal never calls the task', async () => {
    let calls = 0;
    await expect(
      retryOnTransientError(async () => (calls += 1), { ...POLICY, signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });
});
