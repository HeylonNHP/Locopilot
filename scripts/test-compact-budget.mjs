#!/usr/bin/env node
/**
 * Tests for the compaction pipeline's BUDGET arithmetic and for the
 * termination of the map-reduce reduction.
 *
 * Run with: npx tsx scripts/test-compact-budget.mjs
 *
 * No network, no model call — the tests exercise the pure functions in
 * src/services/compact/{budget,reduce,summarize}.ts and the local tokenizer.
 *
 * WHY these tests exist:
 *
 * 1. THE PROMPT HAS TO BE PAID FOR. The instruction prompt is part of the
 *    request, so it is subtracted from the safe input budget before the
 *    history is fitted into what is left. The old floor
 *    (`max(256, safe - prompt)`) applied to the SUBTRACTION, so it
 *    discarded the subtraction entirely whenever the prompt was bigger than
 *    the budget minus 256 tokens: at a 512-token context the prompt was
 *    charged NOTHING and 996 tokens were sent against a 512-token window.
 *    The floor now applies to the TOTAL: the allowance is `safe - prompt`,
 *    floored at zero.
 * 2. A CONTEXT WINDOW THAT IS TOO SMALL MUST FAIL LOUDLY. When the full
 *    prompt does not fit, the pipeline uses the SHORT prompt (the same
 *    six-section contract without the explanation of the input format); when
 *    even that does not fit, the compaction fails with a clear error instead
 *    of sending a request the provider will reject.
 * 3. THE REDUCTION MUST TERMINATE. The old fan-in built its batches under a
 *    budget check, so when every partial summary was bigger than half the
 *    parts budget each batch held exactly ONE part: the number of parts
 *    never shrank and the recursion repeated for ever (51 → 26 → 26 → 26…
 *    at a 2048-token context, and no progress at all at 1024).
 */

import assert from 'node:assert/strict';

import {
  computeEffectiveInputBudget,
  computeSafeInputBudget,
} from '../src/services/compact/budget.ts';
import { MAX_REDUCTION_ROUNDS } from '../src/services/compact/constants.ts';
import {
  batchReductionParts,
  concatenateReductionParts,
  planSummarisationPrompt,
  produceConversationSummary,
} from '../src/services/compact/reduce.ts';
import {
  countRetryPromptTokens,
  countSummarisationPromptTokens,
} from '../src/services/compact/summarize.ts';

const MODEL = 'gpt-4o';

/** The context windows the arithmetic is checked at. */
const CONTEXT_SIZES = [512, 1024, 2048, 8192, 200000];

/** The prompt parameters used for the budget measurements. */
const PROMPT_PARAMS = {
  targetSummaryTokens: 500,
  minSummaryTokens: 300,
  maxSummaryTokens: 800,
  preservedRecentTokens: 1234,
  numCtx: 8192,
};

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

/**
 * Runs one asynchronous check and records the result.
 *
 * @param {string} label - what the check asserts.
 * @param {() => Promise<void>} fn - the check.
 */
async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}

console.log('the effective input budget');

check('the prompt is charged at every context size', () => {
  for (const numCtx of CONTEXT_SIZES) {
    const safe = computeSafeInputBudget(numCtx);
    const promptTokens = 400;
    const allowance = computeEffectiveInputBudget(safe, promptTokens);
    assert.equal(
      allowance,
      Math.max(0, safe - promptTokens),
      `at numCtx ${numCtx} the allowance is ${allowance}, expected ${Math.max(0, safe - promptTokens)}`
    );
  }
});

check('the allowance is never the old 256 floor', () => {
  // The old code returned `max(256, safe - prompt)`, so a small budget
  // silently GREW back to 256 tokens and the prompt was charged nothing.
  for (const [safe, promptTokens] of [
    [100, 40],
    [256, 10],
    [307, 300],
    [614, 600],
  ]) {
    const allowance = computeEffectiveInputBudget(safe, promptTokens);
    assert.ok(
      allowance < 256,
      `the allowance for safe=${safe} prompt=${promptTokens} is ${allowance} — the old 256 floor is back`
    );
    assert.equal(allowance, Math.max(0, safe - promptTokens));
  }
  // And the subtraction is never raised anywhere: the allowance is always
  // the subtraction (floored at zero), never more.
  for (const numCtx of CONTEXT_SIZES) {
    const safe = computeSafeInputBudget(numCtx);
    const promptTokens = countSummarisationPromptTokens(PROMPT_PARAMS, MODEL);
    assert.equal(computeEffectiveInputBudget(safe, promptTokens), Math.max(0, safe - promptTokens));
  }
});

check('the allowance is floored at zero, never negative', () => {
  assert.equal(computeEffectiveInputBudget(100, 400), 0);
  assert.equal(computeEffectiveInputBudget(0, 0), 0);
  assert.equal(computeEffectiveInputBudget(1000, 400), 600);
});

check('the measured prompt costs are subtracted from the budget', () => {
  const safe = computeSafeInputBudget(8192);
  const fullTokens = countSummarisationPromptTokens(PROMPT_PARAMS, MODEL);
  const shortTokens = countRetryPromptTokens(
    {
      targetSummaryTokens: PROMPT_PARAMS.targetSummaryTokens,
      minSummaryTokens: PROMPT_PARAMS.minSummaryTokens,
      maxSummaryTokens: PROMPT_PARAMS.maxSummaryTokens,
      numCtx: PROMPT_PARAMS.numCtx,
    },
    MODEL
  );
  assert.ok(fullTokens > 0, 'the full prompt costs nothing');
  assert.ok(shortTokens > 0, 'the short prompt costs nothing');
  assert.ok(
    shortTokens < fullTokens,
    `the short prompt (${shortTokens}) is not cheaper than the full one (${fullTokens})`
  );
  assert.equal(computeEffectiveInputBudget(safe, fullTokens), safe - fullTokens);
  assert.equal(computeEffectiveInputBudget(safe, shortTokens), safe - shortTokens);
});

console.log('the prompt mode at a small context window');

check('a large context window uses the full prompt', () => {
  const safe = computeSafeInputBudget(8192);
  const plan = planSummarisationPrompt(safe, MODEL, PROMPT_PARAMS);
  assert.ok(plan, 'no plan for a large context window');
  assert.equal(plan.mode, 'full');
  assert.equal(plan.historyBudget, safe - plan.promptTokens);
});

check('a small context window falls back to the short prompt', () => {
  const safe = computeSafeInputBudget(2048);
  const plan = planSummarisationPrompt(safe, MODEL, { ...PROMPT_PARAMS, numCtx: 2048 });
  assert.ok(plan, 'no plan for a small context window');
  assert.equal(plan.mode, 'short');
  // The short prompt must leave MORE room for the history than the full one.
  const fullHistory = computeEffectiveInputBudget(
    safe,
    countSummarisationPromptTokens({ ...PROMPT_PARAMS, numCtx: 2048 }, MODEL)
  );
  assert.ok(
    plan.historyBudget > fullHistory,
    `the short prompt (${plan.historyBudget}) does not leave more room than the full one (${fullHistory})`
  );
});

check('the chunked path is budgeted for its extra prompt sentence', () => {
  const safe = computeSafeInputBudget(8192);
  const plan = planSummarisationPrompt(safe, MODEL, PROMPT_PARAMS);
  assert.ok(plan, 'no plan for a large context window');
  assert.ok(
    plan.chunkHistoryBudget <= plan.historyBudget,
    'the chunked allowance is bigger than the single-pass one'
  );
  assert.ok(
    plan.historyBudget - plan.chunkHistoryBudget < 200,
    `the chunked allowance lost ${plan.historyBudget - plan.chunkHistoryBudget} tokens to the scope sentence`
  );
});

check('an impossibly small context window has no plan at all', () => {
  for (const numCtx of [512, 1024]) {
    const safe = computeSafeInputBudget(numCtx);
    const plan = planSummarisationPrompt(safe, MODEL, { ...PROMPT_PARAMS, numCtx });
    assert.equal(
      plan,
      null,
      `numCtx ${numCtx} got a plan (${plan?.mode}) — the pipeline would send an over-budget request`
    );
  }
});

await checkAsync(
  'the pipeline fails with a clear error at an impossibly small context window',
  async () => {
    const history = [
      { role: 'user', content: 'the status bar crashes on mount, please fix it' },
      { role: 'assistant', content: 'I will look at the component and patch it.' },
    ];
    // The context is never reached: the budget check fails BEFORE any model
    // call, so this test spends no quota.
    await assert.rejects(
      () =>
        produceConversationSummary(
          { baseUrl: 'http://127.0.0.1:1/never-called' },
          MODEL,
          512,
          1,
          history
        ),
      (err) => {
        assert.ok(err instanceof Error, 'the failure is not an Error');
        assert.match(err.message, /too small to compact/i);
        assert.match(
          err.message,
          /512/,
          `the error does not name the context size: ${err.message}`
        );
        return true;
      }
    );
  }
);

console.log('the reduction terminates');

/**
 * Builds a set of partial summaries that are each bigger than half of the
 * parts budget — the shape that used to livelock the reduction.
 *
 * @param {number} count - how many partials to build.
 * @param {number} size - how many characters each one carries.
 * @returns {Array<{number: number, text: string}>} the partials.
 */
function oversizedParts(count, size) {
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const marker = `part-${index + 1}`;
    parts.push({
      number: index + 1,
      text: `Goal: ${marker} ${'x'.repeat(size)}`,
    });
  }
  return parts;
}

check('an oversized batch still makes progress', () => {
  // Every part is far bigger than the whole parts budget, so the budget
  // check would put ONE part in every batch — the count would not shrink.
  const parts = oversizedParts(51, 4000);
  const partsBudget = 512;
  const batches = batchReductionParts(parts, partsBudget, MODEL);
  assert.ok(
    batches.length < parts.length,
    `the batching produced ${batches.length} batches for ${parts.length} parts — no progress`
  );
  assert.ok(
    batches.length <= Math.ceil(parts.length / 2),
    `the batching produced ${batches.length} batches — the parts were not merged in pairs`
  );
});

check('every part appears in exactly one batch', () => {
  const parts = oversizedParts(51, 4000);
  const batches = batchReductionParts(parts, 512, MODEL);
  const seen = batches.flatMap((batch) => batch.map((part) => part.number));
  assert.equal(seen.length, parts.length, 'a part was lost or duplicated');
  assert.deepEqual(
    [...seen].sort((left, right) => left - right),
    parts.map((part) => part.number),
    'the parts were not carried over in order'
  );
});

check('the reduction rounds strictly shrink the number of parts and terminate', () => {
  // The regression test for the livelock: the reduction is simulated with
  // the REAL batching helper, and every round has to produce strictly fewer
  // parts. The old code produced the same number of parts for ever.
  let parts = oversizedParts(51, 4000);
  const partsBudget = 512;
  let rounds = 0;
  while (parts.length > 1) {
    rounds += 1;
    assert.ok(
      rounds <= MAX_REDUCTION_ROUNDS,
      `the reduction did not terminate within ${MAX_REDUCTION_ROUNDS} rounds`
    );
    const batches = batchReductionParts(parts, partsBudget, MODEL);
    assert.ok(
      batches.length < parts.length,
      `round ${rounds} produced ${batches.length} batches for ${parts.length} parts — no progress`
    );
    // The worst case: the model answers with a summary as big as the whole
    // batch, so the next round starts from parts that are just as big.
    parts = batches.map((batch, index) => ({
      number: index + 1,
      text: batch.map((part) => part.text).join('\n\n'),
    }));
  }
  assert.ok(rounds <= MAX_REDUCTION_ROUNDS, 'the reduction needed more rounds than the cap allows');
  assert.ok(rounds > 0, 'the reduction did nothing at all');
});

check('the round cap is a hard bound on the reduction', () => {
  assert.ok(
    MAX_REDUCTION_ROUNDS > 0 && MAX_REDUCTION_ROUNDS <= 16,
    `the round cap (${MAX_REDUCTION_ROUNDS}) is not a sane bound`
  );
});

check('no part is dropped by the final concatenation', () => {
  const parts = oversizedParts(51, 4000);
  const merged = concatenateReductionParts(parts);
  for (const part of parts) {
    assert.ok(
      merged.includes(part.text),
      `the part "${part.text.slice(0, 24)}…" was dropped by the concatenation`
    );
  }
  // Every part is represented exactly once.
  for (const part of parts) {
    const occurrences = merged.split(part.text).length - 1;
    assert.equal(
      occurrences,
      1,
      `the part "${part.text.slice(0, 24)}…" appears ${occurrences} times`
    );
  }
});

check('the concatenation keeps the six-section shape', () => {
  const parts = [
    { number: 1, text: 'Goal: fix the crash\n\nChanges: src/a.ts was written.' },
    { number: 2, text: 'Goal: and run the tests\n\nKey data: npm test failed.' },
  ];
  const merged = concatenateReductionParts(parts);
  assert.match(merged, /^Goal: /m, 'the merged text has no Goal section');
  assert.match(merged, /^Changes: /m, 'the merged text has no Changes section');
  assert.match(merged, /^Key data: /m, 'the merged text has no Key data section');
  assert.ok(merged.includes('fix the crash'), 'the first part was dropped');
  assert.ok(merged.includes('and run the tests'), 'the second part was dropped');
  assert.ok(merged.includes('npm test failed'), 'the second part lost its Key data');
});

check('a part with no section header is not dropped either', () => {
  const parts = [
    { number: 1, text: 'Goal: fix the crash' },
    { number: 2, text: 'a loose remark with no section header' },
  ];
  const merged = concatenateReductionParts(parts);
  assert.ok(
    merged.includes('a loose remark with no section header'),
    `the loose remark was dropped: ${merged}`
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
