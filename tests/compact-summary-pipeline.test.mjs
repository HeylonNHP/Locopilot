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

import { createGoldenFile, describeRequests, runScenario } from './helpers/compactionHarness.mjs';
import { enterScratchCwd } from './helpers/fakeOllama.mjs';

const MODEL = 'test-model';
const FOCUS = 'keep the auth refactor details and the failing test output';
const goldenFile = createGoldenFile(
  new URL('fixtures/compact-summary-pipeline.golden.json', import.meta.url)
);

let scratch;
let produceConversationSummary;
let reduceSummaryGroups;
let buildReductionCombineSystemPrompt;
let TOOL_DISTILL_SYSTEM_PROMPT;
let resetTokenCalibration;

beforeAll(async () => {
  scratch = enterScratchCwd('locopilot-summary-pipeline');
  ({ produceConversationSummary, reduceSummaryGroups } =
    await import('../src/services/compact/reduce.ts'));
  ({ buildReductionCombineSystemPrompt, TOOL_DISTILL_SYSTEM_PROMPT } =
    await import('../src/services/compact/constants.ts'));
  ({ resetTokenCalibration } = await import('../src/services/tokenCalibration.ts'));
  goldenFile.load();
});

afterAll(() => {
  goldenFile.save();
  scratch?.leave();
});

beforeEach(() => {
  resetTokenCalibration();
});

/** Run one scenario against a fresh fake provider (see `runScenario`). */
const scenario = (respond, run) =>
  runScenario({ distillSystemPrompt: TOOL_DISTILL_SYSTEM_PROMPT, respond, run });

/** Compare a scenario's transcript with the stored copy (or record it). */
const expectGolden = (name, fake, progress) =>
  goldenFile.check(name, { requests: describeRequests(fake), progress });

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

/** Run `produceConversationSummary` for a history, collecting progress lines into `progress`. */
function summarise(ctx, progress, history, numCtx, extra = {}) {
  return produceConversationSummary({
    ctx,
    model: MODEL,
    numCtx,
    aggressiveFactor: 1,
    historyMessages: history,
    onProgress: (message) => progress.push(message),
    redactSecrets: true,
    preservedRecentTokens: extra.preservedRecentTokens,
    focus: extra.focus,
  });
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

/**
 * An item the older turns leave open must not be written as "pending".
 *
 * The summariser reads only the older slice, and the cut can fall between a
 * question and its answer; the answer then sits in the preserved window, which
 * the summariser cannot see. These tests read the SYSTEM PROMPT the provider
 * received on every path, with the sentences typed out by hand.
 */
describe('the summariser is told that unseen turns may have settled an open item', () => {
  const MAY_HAVE_SETTLED =
    'may already have settled something that the turns you are given left open';
  const OPEN_WORK = 'Open work: what was still unfinished at the end of what you are given';

  const systemOf = (request) => request.body.messages[0].content;

  test('a single pass with newer turns says they may have settled an item, and why it cannot tell', async () => {
    const { fake, error } = await scenario(
      () => ({ text: 'SUMMARY ONE' }),
      (ctx, log) => summarise(ctx, log, SMALL_HISTORY, 8192, { preservedRecentTokens: 1234 })
    );
    expect(error).toBeUndefined();
    const system = systemOf(fake.requests[0]);
    expect(system).toContain(`Those newer turns ${MAY_HAVE_SETTLED}, and you cannot see them.`);
    expect(system).toContain('open at the end of these turns');
    expect(system).toContain('never as a flat "pending" or "still to do"');
    expect(system).toContain(OPEN_WORK);
  });

  test('a single pass with NO newer turns does not claim any exist', async () => {
    const { fake, error } = await scenario(
      () => ({ text: 'SUMMARY ONE' }),
      (ctx, log) => summarise(ctx, log, SMALL_HISTORY, 8192, { preservedRecentTokens: 0 })
    );
    expect(error).toBeUndefined();
    const system = systemOf(fake.requests[0]);
    expect(system).not.toContain(MAY_HAVE_SETTLED);
    // The purpose line is shared, so the summariser still words the item as open at the end.
    expect(system).toContain(OPEN_WORK);
  });

  test('every chunk of a map-reduce is told, and the combine step is left as it was', async () => {
    const { fake, error } = await scenario(
      ({ index }) => ({ text: `PART ${index}` }),
      (ctx, log) => summarise(ctx, log, bigHistory(14, 1200), 4096, { preservedRecentTokens: 600 })
    );
    expect(error).toBeUndefined();

    const combine = buildReductionCombineSystemPrompt();
    const chunkRequests = fake.requests.filter((request) => systemOf(request) !== combine);
    const combineRequests = fake.requests.filter((request) => systemOf(request) === combine);
    expect(chunkRequests.length).toBeGreaterThan(1);
    expect(combineRequests.length).toBeGreaterThanOrEqual(1);
    for (const request of chunkRequests) {
      expect(systemOf(request)).toContain(
        `The later slices and those newer turns ${MAY_HAVE_SETTLED}`
      );
    }
    // The combine prompt's cost sets the reduction's batching, and it merges
    // summaries that already say "open at the end of these turns".
    for (const request of combineRequests) {
      expect(systemOf(request)).not.toContain(MAY_HAVE_SETTLED);
    }
  });

  test('a chunk with no newer turns is still told that LATER SLICES may have settled an item', async () => {
    const { fake, error } = await scenario(
      ({ index }) => ({ text: `PART ${index}` }),
      (ctx, log) => summarise(ctx, log, bigHistory(14, 1200), 4096, { preservedRecentTokens: 0 })
    );
    expect(error).toBeUndefined();
    const combine = buildReductionCombineSystemPrompt();
    const chunkRequests = fake.requests.filter((request) => systemOf(request) !== combine);
    expect(chunkRequests.length).toBeGreaterThan(1);
    for (const request of chunkRequests) {
      expect(systemOf(request)).toContain(`The later slices ${MAY_HAVE_SETTLED}`);
      expect(systemOf(request)).not.toContain('Those newer turns');
    }
  });

  test('the short prompt carries the purpose line and makes no claim about newer turns', async () => {
    // A 2048-token window cannot pay for the full prompt, so the pipeline uses the short one.
    const { fake, error } = await scenario(
      () => ({ text: 'SUMMARY ONE' }),
      (ctx, log) => summarise(ctx, log, SMALL_HISTORY, 2048, { preservedRecentTokens: 1234 })
    );
    expect(error).toBeUndefined();
    const system = systemOf(fake.requests[0]);
    expect(system).toMatch(
      /^You are a conversation summariser\. Write ONE summary of the text below/
    );
    expect(system).toContain(OPEN_WORK);
    expect(system).not.toContain('newer turns');
  });

  test('the empty-answer retry carries the purpose line too', async () => {
    const { fake, error } = await scenario(
      ({ index }) => ({ text: index === 1 ? '' : 'RETRIED SUMMARY' }),
      (ctx, log) => summarise(ctx, log, SMALL_HISTORY, 8192, { preservedRecentTokens: 1234 })
    );
    expect(error).toBeUndefined();
    expect(fake.requests).toHaveLength(2);
    expect(systemOf(fake.requests[1])).toContain(OPEN_WORK);
  });

  test('the prompt never says that an unseen turn settled anything', async () => {
    // The model has not seen those turns, so a statement about what they
    // contain would be invented. "settled" may only appear after "may already have".
    const { fake } = await scenario(
      () => ({ text: 'SUMMARY ONE' }),
      (ctx, log) => summarise(ctx, log, SMALL_HISTORY, 8192, { preservedRecentTokens: 1234 })
    );
    const system = systemOf(fake.requests[0]);
    const settled = system.match(/settled/g) ?? [];
    const hedged = system.match(/may already have settled/g) ?? [];
    expect(settled.length).toBeGreaterThan(0);
    expect(settled).toHaveLength(hedged.length);
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
        reduceSummaryGroups(
          { ctx, model: MODEL, numCtx: NUM_CTX, onProgress: (message) => log.push(message) },
          1,
          summaries
        )
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
        reduceSummaryGroups(
          { ctx, model: MODEL, numCtx: NUM_CTX, onProgress: (message) => log.push(message) },
          1,
          summaries
        )
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
