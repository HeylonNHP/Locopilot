/**
 * Characterisation of the summary pipeline: `produceConversationSummary`,
 * `summariseMessages` (and the empty-answer retry inside it) and
 * `reduceSummaryGroups`, driven against a fake Ollama server.
 *
 * WHY this file exists: nothing tested these functions offline. The map-reduce
 * path, the empty-response retry and the focus note's travel through every
 * prompt were only exercised by an opt-in live test. The refactor in
 * docs/COMPACTION_REFACTOR_PLAN.md changes their signatures and turns the
 * reduction's recursion into a loop; this file records what they do today.
 *
 * Every scenario PROVES it took its branch with an assertion only that branch
 * can satisfy (more than one chunk request, a combine request, the retry's
 * short prompt, the concatenation progress line), so a fixture whose sizes
 * drift cannot pass by quietly taking the single-pass path. On top of that each
 * scenario's request transcript is compared with a stored copy
 * (tests/fixtures/compact-summary-pipeline.golden.json): the request kind, the
 * output limit and window, a hash of the system prompt and the head of the user
 * message, plus every progress line. Regenerate deliberately with
 *
 *   LOCOPILOT_TEST_WRITE_GOLDEN=1 npm test -- tests/compact-summary-pipeline
 *
 * The provider reports no `prompt_eval_count`, so the pipeline records no
 * calibration sample and every token count stays the local estimate.
 *
 * No network, no model. The scratch working directory keeps `debugLog` output
 * out of the repository's logs/.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  classifyCompactionRequest,
  enterScratchCwd,
  startFakeOllama,
} from './helpers/fakeOllama.mjs';

const MODEL = 'test-model';
const FOCUS = 'keep the auth refactor details and the failing test output';
const GOLDEN_PATH = new URL('fixtures/compact-summary-pipeline.golden.json', import.meta.url);
const WRITE_GOLDEN = process.env['LOCOPILOT_TEST_WRITE_GOLDEN'] === '1';

let scratch;
let produceConversationSummary;
let reduceSummaryGroups;
let buildReductionCombineSystemPrompt;
let TOOL_DISTILL_SYSTEM_PROMPT;
let resetTokenCalibration;

let golden = {};
const written = {};

beforeAll(async () => {
  scratch = enterScratchCwd('locopilot-summary-pipeline');
  ({ produceConversationSummary, reduceSummaryGroups } =
    await import('../src/services/compact/reduce.ts'));
  ({ buildReductionCombineSystemPrompt, TOOL_DISTILL_SYSTEM_PROMPT } =
    await import('../src/services/compact/constants.ts'));
  ({ resetTokenCalibration } = await import('../src/services/tokenCalibration.ts'));
  if (!WRITE_GOLDEN) {
    if (!existsSync(GOLDEN_PATH)) {
      throw new Error('Missing golden file: run with LOCOPILOT_TEST_WRITE_GOLDEN=1 once.');
    }
    golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  }
});

afterAll(() => {
  if (WRITE_GOLDEN) {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(written, null, 2)}\n`);
  }
  scratch?.leave();
});

beforeEach(() => {
  resetTokenCalibration();
});

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/**
 * Run one scenario against a fresh fake provider.
 *
 * @param {(call: object) => object} respond - scripted replies.
 * @param {(ctx: object, progress: string[]) => Promise<any>} run
 */
async function scenario(respond, run) {
  const fake = await startFakeOllama(respond, {
    classify: (body) => classifyCompactionRequest(body, TOOL_DISTILL_SYSTEM_PROMPT),
  });
  const progress = [];
  try {
    const outcome = await run({ baseUrl: fake.baseUrl }, progress).then(
      (value) => ({ value }),
      (err) => ({ error: err })
    );
    return { fake, progress, ...outcome };
  } finally {
    await fake.close();
  }
}

/** What a test records about one request: enough to notice any change, small enough to read. */
function describeRequests(fake) {
  return fake.requests.map(({ index, kind, body }) => {
    const system = body.messages.find((message) => message.role === 'system')?.content ?? '';
    const user = body.messages.findLast((message) => message.role === 'user')?.content ?? '';
    return {
      index,
      kind,
      stream: body.stream,
      options: body.options,
      tools: body.tools ?? null,
      systemSha: sha(system),
      systemHead: system.slice(0, 60),
      userChars: user.length,
      userHead: user.slice(0, 80),
    };
  });
}

/** Compare a scenario's transcript with the stored copy (or record it). */
function expectGolden(name, fake, progress) {
  const transcript = { requests: describeRequests(fake), progress };
  if (WRITE_GOLDEN) {
    written[name] = transcript;
    return;
  }
  expect(golden[name]).toBeDefined();
  expect(transcript).toStrictEqual(golden[name]);
}

/** `count` alternating user/assistant messages of about `chars` characters each. */
function bigHistory(count, chars) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${index + 1}. ${'lorem ipsum dolor sit amet '.repeat(Math.ceil(chars / 27))}`,
  }));
}

const SMALL_HISTORY = [
  { role: 'user', content: 'Please rename the helper and update its callers.' },
  { role: 'assistant', content: 'Renamed it in two files and updated the three call sites.' },
];

/** The arguments of `produceConversationSummary` after `ctx` and `progress`. */
function summarise(ctx, progress, history, numCtx, extra = {}) {
  return produceConversationSummary(
    ctx,
    MODEL,
    numCtx,
    1,
    history,
    (message) => progress.push(message),
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    extra.preservedRecentTokens,
    extra.focus
  );
}

describe('a history that fits is summarised in one pass', () => {
  test('one request, the full prompt, no chunking and no reduction', async () => {
    const { fake, progress, value, error } = await scenario(
      () => ({ text: 'SUMMARY ONE' }),
      (ctx, log) => summarise(ctx, log, SMALL_HISTORY, 8192, { preservedRecentTokens: 1234 })
    );
    expect(error).toBeUndefined();
    expect(value).toBe('SUMMARY ONE');
    expect(fake.unexpected).toStrictEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].kind).toBe('summary');
    expect(fake.requests[0].body.options.num_ctx).toBe(8192);
    expect(progress.join('\n')).not.toMatch(/splitting|Reducing/);
    expectGolden('single pass', fake, progress);
  });
});

describe('a history that does not fit is split, summarised per chunk and reduced', () => {
  const NUM_CTX = 4096;

  test('several chunk requests, then a combine request', async () => {
    const { fake, progress, value, error } = await scenario(
      ({ index, system }) => ({
        text: system === buildReductionCombineSystemPrompt() ? 'COMBINED' : `PART ${index}`,
      }),
      (ctx, log) => summarise(ctx, log, bigHistory(14, 1200), NUM_CTX)
    );
    expect(error).toBeUndefined();
    expect(fake.unexpected).toStrictEqual([]);

    const combine = buildReductionCombineSystemPrompt();
    const chunkRequests = fake.requests.filter(
      (request) => request.body.messages[0].content !== combine
    );
    const combineRequests = fake.requests.filter(
      (request) => request.body.messages[0].content === combine
    );
    // The branch proof: more than one chunk, and at least one combine round.
    expect(chunkRequests.length).toBeGreaterThan(1);
    expect(combineRequests.length).toBeGreaterThanOrEqual(1);
    expect(progress.some((line) => /splitting into \d+ chunks/.test(line))).toBeTruthy();
    expect(progress).toContain('Reducing chunk summaries...');
    expect(value).toBe('COMBINED');
    for (const request of combineRequests) {
      expect(request.body.messages[1].content).toMatch(/^Combine the following partial summaries/);
    }
    expectGolden('chunked and reduced', fake, progress);
  });

  test('the focus note reaches every chunk prompt and every combine prompt', async () => {
    const { fake, error } = await scenario(
      ({ index }) => ({ text: `PART ${index}` }),
      (ctx, log) => summarise(ctx, log, bigHistory(14, 1200), NUM_CTX, { focus: FOCUS })
    );
    expect(error).toBeUndefined();
    expect(fake.requests.length).toBeGreaterThan(2);
    for (const request of fake.requests) {
      expect(request.body.messages[0].content).toContain(FOCUS);
    }
  });
});

describe('the reduction terminates', () => {
  const NUM_CTX = 2048;

  // Each partial summary is bigger than the parts budget, so no two fit one batch.
  const bigSummary = (index) => `Partial ${index}. ${'lorem ipsum dolor sit amet '.repeat(100)}`;

  test('parts that cannot share a batch are paired, and one summary comes out', async () => {
    const summaries = Array.from({ length: 9 }, (_, index) => bigSummary(index + 1));
    const { fake, progress, value, error } = await scenario(
      ({ index }) => ({ text: `COMBINED ${index} ${'x'.repeat(2400)}` }),
      (ctx, log) =>
        reduceSummaryGroups(ctx, MODEL, NUM_CTX, 1, summaries, (message) => log.push(message))
    );
    expect(error).toBeUndefined();
    expect(fake.unexpected).toStrictEqual([]);
    expect(typeof value).toBe('string');
    // Pairing proof: the first round made one request per PAIR (5 for 9 parts), not one per part.
    expect(progress.some((line) => /reduction group 1\/5/.test(line))).toBeTruthy();
    expectGolden('reduction pairing', fake, progress);
  });

  test('after the round cap the remaining parts are merged without a model call', async () => {
    // 300 oversized parts: pairing halves them (300, 150, 75, 38, 19, 10, 5, 3, 2),
    // which takes 8 rounds (150 + 75 + 38 + 19 + 10 + 5 + 3 + 2 = 302 requests),
    // so the cap is reached with 2 parts left. The transcript is too long to
    // store, so the request count and the closing progress line pin it instead.
    const summaries = Array.from({ length: 300 }, (_, index) => bigSummary(index + 1));
    const { fake, progress, value, error } = await scenario(
      ({ index }) => ({ text: `COMBINED ${index} ${'x'.repeat(2400)}` }),
      (ctx, log) =>
        reduceSummaryGroups(ctx, MODEL, NUM_CTX, 1, summaries, (message) => log.push(message))
    );
    expect(error).toBeUndefined();
    expect(fake.unexpected).toStrictEqual([]);
    expect(fake.requests).toHaveLength(302);
    expect(progress.at(-1)).toMatch(
      /^Reduction round limit reached \(8\) — merging the 2 remaining partial summaries without another model call\.$/
    );
    // The two last partial summaries were merged locally, not sent anywhere.
    expect(value.match(/COMBINED \d+ x+/g)).toHaveLength(2);
  });
});

describe('an empty answer is retried once with the short prompt', () => {
  test('the retry carries the short prompt and the source text', async () => {
    const { fake, progress, value, error } = await scenario(
      ({ index }) => ({ text: index === 1 ? '' : 'RETRIED SUMMARY' }),
      (ctx, log) => summarise(ctx, log, SMALL_HISTORY, 8192)
    );
    expect(error).toBeUndefined();
    expect(value).toBe('RETRIED SUMMARY');
    expect(fake.requests).toHaveLength(2);
    const [first, second] = fake.requests.map((request) => request.body.messages);
    expect(second[0].content.length).toBeLessThan(first[0].content.length);
    expect(second[1].content).toMatch(/^Summarise this conversation:\n\n/);
    expect(progress).toContain('Empty response — retrying with simplified prompt...');
    expectGolden('empty answer then retry', fake, progress);
  });

  test('the retry keeps the focus note', async () => {
    const { fake, error } = await scenario(
      ({ index }) => ({ text: index === 1 ? '' : 'RETRIED SUMMARY' }),
      (ctx, log) => summarise(ctx, log, SMALL_HISTORY, 8192, { focus: FOCUS })
    );
    expect(error).toBeUndefined();
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1].body.messages[0].content).toContain(FOCUS);
  });

  test('two empty answers fail with a clear error', async () => {
    const { fake, progress, value, error } = await scenario(
      () => ({ text: '' }),
      (ctx, log) => summarise(ctx, log, SMALL_HISTORY, 8192)
    );
    expect(value).toBeUndefined();
    expect(error?.message).toMatch(/empty summary after two attempts/);
    expect(fake.requests).toHaveLength(2);
    expectGolden('two empty answers', fake, progress);
  });
});
