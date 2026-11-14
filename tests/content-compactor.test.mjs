/**
 * Tests for the web-page compactor's request handling
 * (`ContentCompactor` in src/tools/impl/contentCompactor.ts): the process-wide
 * request cap, the 429 retry, the per-request deadline, and the
 * `outcome: 'truncated'` result that lets the tool tell the LLM a page was cut.
 *
 * The model call is injected (`streamChat`), so there is no network and no
 * provider; sleeping is injected too.
 */

import { describe, expect, test } from '@jest/globals';

import { WEB_COMPACTION_REQUEST_TIMEOUT_MS } from '../src/constants.ts';
import { buildTruncationNote, ContentCompactor } from '../src/tools/impl/contentCompactor.ts';
import { ConcurrencyLimiter } from '../src/util/concurrencyLimiter.ts';

const LIMIT = 200;
const PAGE = 'a sentence about the page. '.repeat(60); // 1,560 characters, over LIMIT
const SUMMARY = 'a short summary.';
const FAST_RETRY = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4 };

const settings = {
  requestTimeoutMs: 720_000,
  perPageCharLimit: LIMIT,
  baseUrl: 'http://ollama.test',
  compactionModel: 'test-model',
};
const ollamaContext = { baseUrl: 'http://ollama.test', provider: 'ollama' };

/** A stream that answers with `text` in one chunk. */
function answering(text) {
  return async function* answer() {
    yield { message: { role: 'assistant', content: text }, done: true };
  };
}

function statusError(status, headers) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    status,
    ...(headers ? { headers } : {}),
  });
}

/** A `streamChat` that follows `steps`: a function (throw or yield) per call. */
function scripted(steps) {
  const calls = [];
  const streamChat = (ctx, params) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push(params);
    return step(ctx, params);
  };
  return { calls, streamChat };
}

const failing = (error) =>
  async function* fail() {
    yield* [];
    throw error;
  };

function compactor(streamChat, overrides = {}) {
  return ContentCompactor.create(settings, ollamaContext, {
    streamChat,
    retryPolicy: FAST_RETRY,
    sleep: async () => false,
    limiter: new ConcurrencyLimiter(4),
    ...overrides,
  });
}

describe('compact: outcomes', () => {
  test('text within the limit is returned untouched and the model is never called', async () => {
    const { calls, streamChat } = scripted([answering(SUMMARY)]);
    const result = await compactor(streamChat).compact('short');
    expect(result).toMatchObject({ text: 'short', outcome: 'unchanged' });
    expect(calls).toHaveLength(0);
  });

  test('a summary under the limit is reported as compacted', async () => {
    const { streamChat } = scripted([answering(SUMMARY)]);
    const result = await compactor(streamChat).compact(PAGE);
    expect(result).toMatchObject({
      text: SUMMARY,
      outcome: 'compacted',
      originalLength: PAGE.length,
      limit: LIMIT,
    });
    expect(result.reason).toBeUndefined();
  });

  test('compactIfNeeded still returns just the text', async () => {
    const { streamChat } = scripted([answering(SUMMARY)]);
    await expect(compactor(streamChat).compactIfNeeded(PAGE)).resolves.toBe(SUMMARY);
  });

  test('a model that never gets under the limit leaves a TRUNCATED page, not a "compacted" one', async () => {
    const tooLong = 'x'.repeat(LIMIT + 50);
    const { streamChat } = scripted([answering(tooLong)]);
    const result = await compactor(streamChat).compact(PAGE);
    expect(result.outcome).toBe('truncated');
    expect(result.text).toHaveLength(LIMIT);
    expect(result.reason).toMatch(/under the limit/);
  });

  test('a failed request is a truncated page that says why, cut to the limit', async () => {
    const { streamChat } = scripted([failing(statusError(400))]);
    const result = await compactor(streamChat).compact(PAGE);
    expect(result.outcome).toBe('truncated');
    expect(result.text).toBe(PAGE.slice(0, LIMIT));
    expect(result.reason).toMatch(/status code 400/);
  });
});

describe('buildTruncationNote', () => {
  test('says the page was not summarised, how much was kept, and how to get the rest', () => {
    const note = buildTruncationNote({
      text: '',
      outcome: 'truncated',
      reason: 'summarising it failed (HTTP 429)',
      originalLength: 12_345,
      limit: 5000,
    });
    expect(note).toContain('NOT summarised');
    expect(note).toContain('12345');
    expect(note).toContain('5000');
    expect(note).toContain('HTTP 429');
    expect(note).toContain('full_content=true');
  });
});

describe('compact: retrying a transient failure', () => {
  test('a 429 is retried and the later summary is used (not truncated)', async () => {
    const { calls, streamChat } = scripted([
      failing(statusError(429)),
      failing(statusError(503)),
      answering(SUMMARY),
    ]);
    const result = await compactor(streamChat).compact(PAGE);
    expect(result).toMatchObject({ text: SUMMARY, outcome: 'compacted' });
    expect(calls).toHaveLength(3);
  });

  test('a 429 that never clears ends as a truncated page that names the 429', async () => {
    const { calls, streamChat } = scripted([failing(statusError(429))]);
    const result = await compactor(streamChat).compact(PAGE);
    expect(calls).toHaveLength(FAST_RETRY.maxAttempts);
    expect(result.outcome).toBe('truncated');
    expect(result.reason).toMatch(/429/);
  });

  test('a 400 is not backed off and retried (only the existing reasoning-flag re-send happens)', async () => {
    const delays = [];
    const { calls, streamChat } = scripted([failing(statusError(400))]);
    await compactor(streamChat, {
      sleep: async (ms) => {
        delays.push(ms);
        return false;
      },
    }).compact(PAGE);
    // `think: false` is dropped and the request re-sent once, whatever the
    // 400 says (streamCompactionResponse); the backoff retry never fires.
    expect(calls).toHaveLength(2);
    expect(calls[0].think).toBe(false);
    expect(calls[1].think).toBeUndefined();
    expect(delays).toEqual([]);
  });

  test('an OpenAI-compatible provider is not retried here: its adapter already retried', async () => {
    const { calls, streamChat } = scripted([failing(statusError(429))]);
    const c = ContentCompactor.create(
      settings,
      { baseUrl: 'http://gateway.test', provider: 'openai-compatible' },
      { streamChat, sleep: async () => false, limiter: new ConcurrencyLimiter(4) }
    );
    const result = await c.compact(PAGE);
    expect(calls).toHaveLength(1);
    expect(result.outcome).toBe('truncated');
  });

  test('the backoff waits for the server Retry-After', async () => {
    const delays = [];
    const { streamChat } = scripted([
      failing(statusError(429, new Headers({ 'retry-after': '3' }))),
      answering(SUMMARY),
    ]);
    await compactor(streamChat, {
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 16_000 },
      sleep: async (ms) => {
        delays.push(ms);
        return false;
      },
    }).compact(PAGE);
    expect(delays).toEqual([3000]);
  });

  test('the request slot is given back during the backoff, so another page can use it', async () => {
    // One slot. Page A gets a 429 and goes to sleep; page B must run while A sleeps.
    let wakeA;
    const sleeping = new Promise((resolve) => {
      wakeA = () => resolve(false);
    });
    let aSleeping;
    const aIsSleeping = new Promise((resolve) => {
      aSleeping = resolve;
    });
    let call = 0;
    const streamChat = (ctx, params) => {
      call += 1;
      if (call === 1) return failing(statusError(429))();
      return answering(`summary for call ${call}`)(ctx, params);
    };
    const limiter = new ConcurrencyLimiter(1);
    const c = compactor(streamChat, {
      limiter,
      sleep: () => {
        aSleeping();
        return sleeping;
      },
    });

    const a = c.compact(PAGE);
    await aIsSleeping;
    const b = await compactor(streamChat, { limiter }).compact(PAGE);
    expect(b.text).toBe('summary for call 2');
    wakeA();
    const resumed = await a;
    expect(resumed.text).toBe('summary for call 3');
  });
});

describe('compact: the request deadline', () => {
  /** A stream that hangs until the request is aborted. */
  const hangingUntilAborted = (endQuietly) =>
    async function* hang(_ctx, params) {
      yield { message: { role: 'assistant', content: 'a partial summ' }, done: false };
      await new Promise((resolve, reject) => {
        params.signal.addEventListener('abort', () =>
          endQuietly ? resolve() : reject(new Error('socket closed'))
        );
      });
    };

  test('the default deadline is the named constant', () => {
    expect(WEB_COMPACTION_REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  test('every request carries a deadline signal and the timeout', async () => {
    const { calls, streamChat } = scripted([answering(SUMMARY)]);
    await compactor(streamChat).compact(PAGE);
    expect(calls[0].timeoutMs).toBe(WEB_COMPACTION_REQUEST_TIMEOUT_MS);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ['the stream errors when aborted', false],
    ['the stream ends QUIETLY when aborted, with a partial text', true],
  ])('a request past the deadline falls back to a truncated page: %s', async (_name, quiet) => {
    const { streamChat } = scripted([hangingUntilAborted(quiet)]);
    const result = await compactor(streamChat, {
      requestTimeoutMs: 25,
      // A timeout is not transient: it must not be retried (another 60 s).
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4 },
    }).compact(PAGE);
    expect(result.outcome).toBe('truncated');
    expect(result.reason).toMatch(/timed out/);
    // The partial summary must NOT be passed off as the compacted text.
    expect(result.text).not.toContain('partial summ');
  });

  test('a timeout is not retried', async () => {
    const { calls, streamChat } = scripted([hangingUntilAborted(false)]);
    await compactor(streamChat, { requestTimeoutMs: 25 }).compact(PAGE);
    expect(calls).toHaveLength(1);
  });
});

describe('compact: aborting', () => {
  test('an abort rejects instead of returning a truncated page', async () => {
    const controller = new AbortController();
    const streamChat = async function* wait(_ctx, params) {
      yield* [];
      await new Promise((_, reject) =>
        params.signal.addEventListener('abort', () => reject(new Error('aborted')))
      );
    };
    const promise = compactor(streamChat).compact(PAGE, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow();
  });

  test('an already-aborted signal never reaches the model', async () => {
    const { calls, streamChat } = scripted([answering(SUMMARY)]);
    await expect(compactor(streamChat).compact(PAGE, AbortSignal.abort())).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });
});

describe('compact: the shared request cap', () => {
  test('never has more requests in flight than the limiter allows, across compactors', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let inFlight = 0;
    let peak = 0;
    const streamChat = async function* slow() {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      yield { message: { role: 'assistant', content: SUMMARY }, done: true };
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => compactor(streamChat, { limiter }).compact(PAGE))
    );
    expect(peak).toBe(2);
    expect(results.every((r) => r.outcome === 'compacted')).toBe(true);
  });
});
