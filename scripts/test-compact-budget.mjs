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
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeCompactionReserveTokens,
  computeCompactionTriggerTokens,
  computeDistillCallCap,
  computeEffectiveInputBudget,
  computeSafeInputBudget,
  evaluateCompactionSizes,
} from '../src/services/compact/budget.ts';
import {
  MAX_REDUCTION_ROUNDS,
  TOOL_DISTILL_CHAR_THRESHOLD,
  TOOL_DISTILL_MAX_CALLS,
  TOOL_DISTILL_MIN_CALLS,
} from '../src/services/compact/constants.ts';
import { distillToolMessages, planDistillation } from '../src/services/compact/distill.ts';
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
import { forwardableReasoningEffort } from '../src/types/chatConfig.ts';

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

check('the short prompt charges the focus note', () => {
  // The focus note is rule 6 of the SHORT prompt, so the short prompt costs
  // more when a note is present. The short branch of `planSummarisationPrompt`
  // used to build its measurement object by hand and drop `params.focus`, so it
  // measured a prompt the request would never send: at numCtx 2048 a long note
  // understated the prompt by ~294 tokens (557 against 851), a ~24 %
  // overstatement of the history budget that every chunk then inherited.
  const safe = computeSafeInputBudget(2048);
  const base = { ...PROMPT_PARAMS, numCtx: 2048 };
  const focus = 'keep the auth refactor details and the failing test output, '.repeat(4).trim();
  const withoutFocus = planSummarisationPrompt(safe, MODEL, base);
  const withFocus = planSummarisationPrompt(safe, MODEL, { ...base, focus });
  assert.ok(withoutFocus && withFocus, 'no short-prompt plan');
  assert.equal(withoutFocus.mode, 'short');
  assert.equal(withFocus.mode, 'short');

  // The plan's prompt cost is exactly what the SHORT prompt builder charges
  // for — with the note in it.
  const expectedWithFocus = countRetryPromptTokens(
    {
      targetSummaryTokens: base.targetSummaryTokens,
      minSummaryTokens: base.minSummaryTokens,
      maxSummaryTokens: base.maxSummaryTokens,
      numCtx: base.numCtx,
      focus,
    },
    MODEL
  );
  assert.equal(
    withFocus.promptTokens,
    expectedWithFocus,
    'the short plan measures a prompt that is not the one it will send'
  );
  const focusCost = expectedWithFocus - withoutFocus.promptTokens;
  assert.ok(focusCost > 50, `the note cost only ${focusCost} tokens — the fixture is too small`);
  assert.equal(
    withoutFocus.historyBudget - withFocus.historyBudget,
    focusCost,
    'the note is not charged against the history budget'
  );

  // And the charge can be DECISIVE: a note that the old measurement ignored
  // takes the plan from "671 tokens of history" to "no plan at all", because
  // the short prompt would leave too little for the history the summary has to
  // read. The old code happily planned a request 192 tokens over the budget.
  const longFocus = 'keep the auth refactor details and the failing test output, '
    .repeat(15)
    .trim();
  assert.equal(
    planSummarisationPrompt(safe, MODEL, { ...base, focus: longFocus }),
    null,
    'a note that pushes the short prompt past the history floor still produced a plan'
  );
});

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

console.log('the auto-compaction trigger reserves room for the reply');

/**
 * The trigger each context window has to produce.
 *
 * These are the sizes people actually run: a small local window, the common
 * 8k/32k/128k hosted windows, and a 1M-token window where the reserve clamp
 * (and then the 97 % ceiling) takes over.
 */
const TRIGGER_TABLE = [
  [2048, 1229],
  [4096, 2596],
  [8192, 6144],
  [32768, 24576],
  [131072, 118072],
  [200000, 187000],
  [1000000, 970000],
];

check('the trigger is the window minus a reserved reply margin', () => {
  for (const [numCtx, expected] of TRIGGER_TABLE) {
    assert.equal(
      computeCompactionTriggerTokens(numCtx),
      expected,
      `a ${numCtx}-token window fires at ${computeCompactionTriggerTokens(numCtx)}, expected ${expected}`
    );
  }
});

check('the reserve is 25 % of the window, clamped and capped', () => {
  assert.equal(computeCompactionReserveTokens(8192), 2048);
  // The MIN clamp: 25 % of 4096 is 1024, below the 1500 floor.
  assert.equal(computeCompactionReserveTokens(4096), 1500);
  // The MAX clamp: 25 % of 131072 is 32768, far above the 13000 ceiling.
  assert.equal(computeCompactionReserveTokens(131072), 13000);
  // The WINDOW cap: the clamp alone would reserve 1500 of 2048 tokens (73 %),
  // so compaction would fire almost constantly — and the pipeline cannot fit
  // its own short prompt in what would be left.
  assert.equal(computeCompactionReserveTokens(2048), 819);
  assert.ok(
    computeCompactionReserveTokens(2048) < 1500,
    'the 40 % window cap is not being applied'
  );
});

check('the trigger strictly increases with the window', () => {
  const sizes = [512, 1024, 2048, 4096, 6000, 8192, 16384, 32768, 131072, 200000, 500000, 1000000];
  for (let index = 1; index < sizes.length; index += 1) {
    const previous = computeCompactionTriggerTokens(sizes[index - 1]);
    const current = computeCompactionTriggerTokens(sizes[index]);
    assert.ok(
      current > previous,
      `the trigger did not grow from ${sizes[index - 1]} (${previous}) to ${sizes[index]} (${current})`
    );
  }
});

check('the trigger stays between 50 % and 97 % of the window', () => {
  // A sweep rather than a table: the arithmetic has three regimes (the 40 %
  // cap, the 25 % band and the 97 % ceiling) and the boundaries between them
  // are what a table would silently step over.
  for (let numCtx = 512; numCtx <= 1000000; numCtx += 7919) {
    const trigger = computeCompactionTriggerTokens(numCtx);
    assert.ok(
      trigger > numCtx * 0.5,
      `at numCtx ${numCtx} the trigger ${trigger} is not above 50 % — it would fire too early`
    );
    assert.ok(
      trigger <= numCtx * 0.97,
      `at numCtx ${numCtx} the trigger ${trigger} is above 97 % — it would fire too late`
    );
  }
});

check('a window that is not a positive finite number has no trigger', () => {
  for (const numCtx of [0, -1, -8192, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(computeCompactionTriggerTokens(numCtx), 0, `trigger for numCtx ${numCtx}`);
    assert.equal(computeCompactionReserveTokens(numCtx), 0, `reserve for numCtx ${numCtx}`);
  }
});

check('an 8k window leaves a 2048-token reply', () => {
  // The regression the whole change exists for: the old flat 92 % gate fired
  // at 7360 of 8192 and left 640 tokens — less than one tool call plus its
  // result, so the turn could not finish the request it had just compacted.
  const numCtx = 8192;
  const replyRoom = numCtx - computeCompactionTriggerTokens(numCtx);
  assert.ok(replyRoom >= 2048, `only ${replyRoom} tokens are left for the reply`);
  assert.ok(replyRoom > Math.floor(numCtx * 0.08), 'the old 8 % reply margin is back');
});

console.log('the compaction size verdict');

check('a compaction that does not shrink the history is aborted', () => {
  const verdict = evaluateCompactionSizes(7000, 7000, 8192);
  assert.equal(verdict.aborted, true, 'a compaction that shrank nothing was accepted');
  assert.equal(evaluateCompactionSizes(7000, 7500, 8192).aborted, true, 'growth was accepted');
  assert.equal(
    evaluateCompactionSizes(7000, 5000, 8192).aborted,
    false,
    'a shrinking result was rejected'
  );
  // With no OLD count there is nothing to compare against and nothing to abort.
  assert.equal(evaluateCompactionSizes(0, 0, 8192).aborted, false);
});

check('a compaction inside the confirm band is retried after a live check', () => {
  // 7400 of 8192 is 90.3 %: past the 90 % acceptance boundary, but close
  // enough to it that the local estimate could be wrong either way. The OLD
  // count here is 8000, so the compaction did shrink the history — the retry
  // is about what is LEFT, not about whether anything was removed.
  const verdict = evaluateCompactionSizes(8000, 7400, 8192);
  assert.equal(verdict.aborted, false);
  assert.equal(verdict.retry, true);
  assert.equal(verdict.confirm, true, 'a boundary-adjacent size was not confirmed');
});

check('a compaction far above the boundary is retried without a measurement', () => {
  // 7900 of 8192 is 96.4 %, well outside the ±5 % band: no estimate error can
  // make it acceptable, so paying for a live measurement would buy nothing.
  const verdict = evaluateCompactionSizes(8000, 7900, 8192);
  assert.equal(verdict.retry, true);
  assert.equal(verdict.confirm, false, 'a clear retry still paid for a measurement');
});

check('a compaction just under the boundary is inside the confirm band', () => {
  // 7100 of 8192 is 86.7 %: under the boundary, so no retry — but inside the
  // 85–95 % band, so "accept it" is exactly the decision the estimate cannot
  // be trusted with on its own.
  const verdict = evaluateCompactionSizes(8000, 7100, 8192);
  assert.equal(verdict.retry, false);
  assert.equal(verdict.confirm, true);
});

check('a compaction well under the boundary is accepted without a measurement', () => {
  const verdict = evaluateCompactionSizes(8000, 5000, 8192);
  assert.equal(verdict.retry, false);
  assert.equal(verdict.confirm, false);
});

check('refusing a compaction that shrank nothing outranks the retry', () => {
  // 7400 is above the acceptance boundary, so it ALSO looks retryable — but a
  // result that is no smaller than its input is refused outright, because a
  // stronger pass over a history it could not shrink is a wasted model call.
  const verdict = evaluateCompactionSizes(7000, 7400, 8192);
  assert.equal(verdict.aborted, true);
});

check('the retry and confirm boundaries sit exactly at 90 %, 85 % and 95 %', () => {
  // A 10000-token window makes the percentages exact: 9000 / 8500 / 9500.
  const numCtx = 10000;
  assert.equal(evaluateCompactionSizes(numCtx, 9000, numCtx).retry, false, '90 % retried');
  assert.equal(evaluateCompactionSizes(numCtx, 9001, numCtx).retry, true, '90 % + 1 accepted');
  assert.equal(evaluateCompactionSizes(numCtx, 8500, numCtx).confirm, true, '85 % not confirmed');
  assert.equal(
    evaluateCompactionSizes(numCtx, 8499, numCtx).confirm,
    false,
    'below 85 % confirmed'
  );
  assert.equal(evaluateCompactionSizes(numCtx, 9500, numCtx).confirm, true, '95 % not confirmed');
  assert.equal(
    evaluateCompactionSizes(numCtx, 9501, numCtx).confirm,
    false,
    'above 95 % confirmed'
  );
});

check('a verdict with no usable window never retries or confirms', () => {
  const verdict = evaluateCompactionSizes(7000, 6900, 0);
  assert.deepEqual(verdict, { aborted: false, retry: false, confirm: false });
});

console.log('the distillation call cap');

/**
 * The cap each context window has to produce.
 *
 * One call per 16k of window, clamped to `[2, 8]`.
 */
const DISTILL_CAP_TABLE = [
  [2048, 2],
  [4096, 2],
  [8192, 2],
  [32768, 2],
  [65536, 4],
  [131072, TOOL_DISTILL_MAX_CALLS],
  [1000000, TOOL_DISTILL_MAX_CALLS],
];

check('the distillation cap scales with the window and is clamped', () => {
  for (const [numCtx, expected] of DISTILL_CAP_TABLE) {
    assert.equal(
      computeDistillCallCap(numCtx),
      expected,
      `a ${numCtx}-token window gets ${computeDistillCallCap(numCtx)} calls, expected ${expected}`
    );
  }
});

check('the distillation cap never falls below the floor or above the ceiling', () => {
  for (let numCtx = 512; numCtx <= 1000000; numCtx += 4099) {
    const cap = computeDistillCallCap(numCtx);
    assert.ok(
      cap >= TOOL_DISTILL_MIN_CALLS && cap <= TOOL_DISTILL_MAX_CALLS,
      `at numCtx ${numCtx} the cap is ${cap}`
    );
  }
  for (const numCtx of [0, -8192, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      computeDistillCallCap(numCtx),
      TOOL_DISTILL_MIN_CALLS,
      `a window of ${numCtx} did not get the floor`
    );
  }
});

console.log('the distillation planner spends calls on the biggest results');

/**
 * Builds an assistant + tool pair whose tool result carries `chars` characters.
 *
 * @param {number} chars - the size of the tool output.
 * @param {string} id - the tool-call id (must be unique within a fixture).
 * @returns {object[]} the two messages.
 */
function distillPair(chars, id) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', content: 'x'.repeat(chars), tool_call_id: id },
  ];
}

/**
 * Builds a history of assistant + tool pairs from a list of sizes.
 *
 * @param {number[]} sizes - one tool-output size per pair.
 * @returns {object[]} the history.
 */
function distillFixture(sizes) {
  return sizes.flatMap((size, index) => distillPair(size, `call-${index}`));
}

/** The tool-row index of the pair built at `pairIndex`. */
const toolIndex = (pairIndex) => pairIndex * 2 + 1;

check('the three largest eligible outputs are selected, in ascending index order', () => {
  // Unequal sizes on purpose: a positional policy would spend its calls on the
  // first three, which are the smallest ones here.
  const sizes = [1300, 5000, 2000, 40000, 1500, 8000, 3000, 1600, 12000, 6000];
  const history = distillFixture(sizes);
  const plan = planDistillation(history, 3);
  assert.deepEqual(
    plan.selected,
    [toolIndex(3), toolIndex(5), toolIndex(8)],
    `selected ${JSON.stringify(plan.selected)} — expected the 40000, 8000 and 12000 rows`
  );
  assert.equal(plan.skipped, sizes.length - 3);
  // Ascending, so the caller can rebuild the history in one pass.
  assert.deepEqual(
    [...plan.selected].sort((left, right) => left - right),
    plan.selected
  );
});

check('equal sizes are broken by position, lowest index first', () => {
  const history = distillFixture([4000, 2000, 4000]);
  const plan = planDistillation(history, 1);
  assert.deepEqual(plan.selected, [toolIndex(0)], 'the tie was not broken by position');
});

check('a tool row with no matching assistant is neither selected nor counted', () => {
  const [assistantA, toolA] = distillPair(9000, 'call-a');
  const [, toolB] = distillPair(20000, 'call-b');
  const orphan = { role: 'tool', content: 'x'.repeat(30000), tool_call_id: 'call-missing' };
  const history = [assistantA, toolA, orphan, toolB];
  const plan = planDistillation(history, 1);
  // The orphan is the biggest row in the slice, and it is still not selected:
  // distillation would have no owning call to name, and its digest would be an
  // orphan tool row afterwards.
  assert.deepEqual(plan.selected, [toolIndex(0)], 'the orphan was selected');
  assert.equal(plan.skipped, 0, 'the orphan was counted as a skipped candidate');
});

check('a row below the character threshold is not a candidate', () => {
  const history = distillFixture([TOOL_DISTILL_CHAR_THRESHOLD - 1, TOOL_DISTILL_CHAR_THRESHOLD]);
  const plan = planDistillation(history, 8);
  assert.deepEqual(plan.selected, [toolIndex(1)], 'the short row was selected');
  assert.equal(plan.skipped, 0);
});

check('a cap of zero selects nothing and reports every candidate as skipped', () => {
  const history = distillFixture([2000, 3000, 4000]);
  const plan = planDistillation(history, 0);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.skipped, 3);
});

check('a cap larger than the candidate list selects everything', () => {
  const history = distillFixture([2000, 3000]);
  const plan = planDistillation(history, TOOL_DISTILL_MAX_CALLS);
  assert.deepEqual(plan.selected, [toolIndex(0), toolIndex(1)]);
  assert.equal(plan.skipped, 0);
});

check('an oversized tool row with no owning assistant is counted apart from the cap', () => {
  // The progress line used to say that `skippedCount` outputs "stay verbatim",
  // which was untrue of the window as a whole: an orphan row stays verbatim
  // too, and the cap never chose to leave it. The planner now counts them
  // separately so the line can name both.
  const [assistantA, toolA] = distillPair(9000, 'call-a');
  const [assistantB, toolB] = distillPair(20000, 'call-b');
  const orphanAbove = { role: 'tool', content: 'x'.repeat(30000), tool_call_id: 'call-missing' };
  const orphanBelow = { role: 'tool', content: 'x'.repeat(10), tool_call_id: 'call-tiny' };
  const plan = planDistillation(
    [assistantA, toolA, orphanAbove, orphanBelow, assistantB, toolB],
    1
  );
  assert.equal(plan.skipped, 1, 'the capped candidate is not counted as skipped');
  assert.equal(
    plan.orphans,
    1,
    'only the ABOVE-threshold orphan counts — a small row is not an oversized output'
  );
});

console.log('a failed distillation does not cost the whole compaction');

/**
 * A history with one oversized tool output and its owning assistant.
 *
 * @returns {object[]} the slice to distill.
 */
function distillFailureFixture() {
  return [
    ...distillPair(9000, 'call-fail-1'),
    { role: 'assistant', content: 'checking the second file' },
    ...distillPair(8000, 'call-fail-2'),
    { role: 'user', content: 'carry on' },
  ];
}

/**
 * An LLM context whose calls fail at the TRANSPORT layer (port 1 refuses the
 * connection immediately) — no network, no quota, no model.
 */
const REFUSING_CTX = { baseUrl: 'http://127.0.0.1:1' };

await checkAsync(
  'a failing distillation call keeps its message verbatim, and the pass goes on',
  async () => {
    const history = distillFailureFixture();
    const progress = [];
    const result = await distillToolMessages(REFUSING_CTX, history, 8192, MODEL, 2, (message) =>
      progress.push(message)
    );
    // Two candidates, two failed calls: the loop did not stop after the first
    // throw, and nothing was replaced.
    assert.equal(result.failedCount, 2, `failedCount is ${result.failedCount}, expected 2`);
    assert.equal(result.distilledCount, 0);
    assert.deepEqual(
      result.messages.map((entry) => entry.content),
      history.map((entry) => entry.content),
      'a failed call changed the history'
    );
    assert.equal(result.messages.length, history.length, 'the pass lost a message');
    // Not silent: one line names how many calls failed.
    const reported = progress.filter((line) => /2 tool distillation call\(s\) failed/.test(line));
    assert.equal(
      reported.length,
      1,
      `the failure was not reported once: ${JSON.stringify(progress)}`
    );
  }
);

await checkAsync('an abort still propagates out of the distiller', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      distillToolMessages(
        REFUSING_CTX,
        distillFailureFixture(),
        8192,
        MODEL,
        2,
        undefined,
        controller.signal
      ),
    'an aborted compaction was swallowed as a per-message failure'
  );
});

console.log('the retry pass knows the system prompt');

check('compactHistory takes the system-prompt tokens and forwards them', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/services/compact/orchestrate.ts', import.meta.url)),
    'utf8'
  );
  // The parameter exists because the retry recursion deliberately passes a
  // history WITHOUT the system row, so the inner pass would compute 0.
  assert.ok(
    source.includes('systemPromptTokens?: number'),
    'compactHistory has no systemPromptTokens parameter'
  );
  assert.ok(
    source.includes('systemPromptTokens ?? countMessagesTokens(systemMessages, model)'),
    'the system-prompt tokens are not derived from the system rows when absent'
  );
  const retryIndex = source.indexOf('const retryResult = await compactHistory(');
  assert.notEqual(retryIndex, -1, 'compactHistory has no retry recursion');
  const retryCall = source.slice(retryIndex, source.indexOf('\n    );', retryIndex));
  assert.match(
    retryCall,
    /focus,[\S\s]*\bresolvedSystemPromptTokens\b/,
    'the retry recursion does not pass the system-prompt tokens through'
  );
  // And the NEW count (the one the acceptance decision and the stats use) is
  // the local count plus that number.
  assert.ok(
    source.includes('countMessagesTokens(newMessages, model) + resolvedSystemPromptTokens'),
    'the new-history count does not include the system prompt'
  );
});

console.log('the reasoning effort forwarded to the summariser');

check("the UI default 'off' is never forwarded", () => {
  assert.equal(forwardableReasoningEffort(undefined), undefined);
  assert.equal(forwardableReasoningEffort('off'), undefined);
  assert.equal(forwardableReasoningEffort('high'), 'high');
  assert.equal(forwardableReasoningEffort('none'), 'none');
  assert.equal(forwardableReasoningEffort('max'), 'max');
});

console.log('the retired 92 % gate and the measurement cost');

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Lists every TypeScript source file under `src/`, recursively.
 *
 * @param {string} dir - the directory to walk.
 * @returns {string[]} absolute paths of the `.ts` / `.tsx` files found.
 */
function listSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

check('no source file still names the retired flat 92 % gate', () => {
  const offenders = listSourceFiles(path.join(REPO_ROOT, 'src')).filter((file) =>
    readFileSync(file, 'utf8').includes('AUTO_COMPACT_THRESHOLD_PCT')
  );
  assert.deepEqual(
    offenders.map((file) => file.slice(REPO_ROOT.length)),
    [],
    'the retired constant is still referenced'
  );
});

check('the pipeline measures a conversation once, and only to confirm', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'), 'utf8');
  const calls = source.match(/measureConversationTokens\(/g) ?? [];
  // The import statement carries no parenthesis, so only real CALLS match.
  assert.equal(
    calls.length,
    1,
    `orchestrate.ts calls measureConversationTokens ${calls.length} times — one per compaction is the budget`
  );
  const confirmIndex = source.indexOf('if (verdict.confirm)');
  assert.ok(confirmIndex !== -1, 'orchestrate.ts has no confirm branch');
  assert.ok(
    source.indexOf('measureConversationTokens(') > confirmIndex,
    'the live measurement is not inside the confirm branch'
  );
  // Both sizes come from the free local tokenizer.
  const localCounts = source.match(/countMessagesTokens\(/g) ?? [];
  assert.ok(
    localCounts.length >= 2,
    `orchestrate.ts counts tokens locally only ${localCounts.length} time(s)`
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
