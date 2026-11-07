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
  computeDistillDigestMaxChars,
  computeDistillInputMaxChars,
  computeDistillNumPredict,
  computeDistillPrefillBudgetTokens,
  computeDistillTimeoutMs,
  computeEffectiveInputBudget,
  computeSafeInputBudget,
  DISTILL_CHARS_PER_TOKEN,
  DISTILL_OUTPUT_CHARS_PER_TOKEN,
  estimateDistillPrefillTokens,
  evaluateCompactionSizes,
} from '../src/services/compact/budget.ts';
import {
  COMPACT_RESERVE_MAX_TOKENS,
  COMPACT_RESERVE_MAX_WINDOW_RATIO,
  COMPACT_RESERVE_MIN_TOKENS,
  COMPACT_RESERVE_RATIO,
  MAX_REDUCTION_ROUNDS,
  RECENT_FILES_MAX_TOTAL_TOKENS,
  RECENT_FILES_MAX_WINDOW_RATIO,
  RECENT_FILES_MESSAGE_FRAMING_TOKENS,
  RECENT_FILES_MESSAGE_OVERHEAD_TOKENS,
  RECENT_FILES_MIN_TOKENS,
  TOOL_DISTILL_CHAR_THRESHOLD,
  TOOL_DISTILL_DIGEST_MAX_CHARS_CEILING,
  TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE,
  TOOL_DISTILL_INPUT_OVERHEAD_TOKENS,
  TOOL_DISTILL_MAX_CALLS,
  TOOL_DISTILL_MAX_CHARS_WINDOW_RATIO,
  TOOL_DISTILL_MIN_CALLS,
  TOOL_DISTILL_NUM_PREDICT_BASE,
  TOOL_DISTILL_NUM_PREDICT_MAX,
  TOOL_DISTILL_PREFILL_BUDGET_WINDOW_RATIO,
  TOOL_DISTILL_TIMEOUT_BASE_MS,
  TOOL_DISTILL_TIMEOUT_MAX_MS,
  TOOL_DISTILL_TRUNCATION_MARKER,
} from '../src/services/compact/constants.ts';
import {
  createDistillBudget,
  distillToolMessages,
  planDistillation,
  planDistillCalls,
  truncateToolOutputForDistillation,
} from '../src/services/compact/distill.ts';
import { computeRecentFilesBudget } from '../src/services/compact/recentFiles.ts';
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
import { countMessageTokens, countTextTokens } from '../src/services/tokenizer.ts';
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
  assert.ok(rounds > 0, 'the reduction did not do anything at all');
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
 * 8k/32k/128k hosted windows, and the 1M-token window where the √ reply
 * reserve (and then the 97 % ceiling) takes over.
 *
 * 131 072 and above are the windows the √ reserve moves: the reserve used to
 * be a flat 13 000 tokens, which is 1.2 % of a 1M window — so the trigger sat
 * at 95 %/97 % of the window and a long reply overflowed mid-generation.
 */
const TRIGGER_TABLE = [
  [2048, 1229],
  [4096, 2596],
  [8192, 6144],
  [32768, 24576],
  [131072, 114688],
  [200000, 179762],
  [1000000, 954746],
  [1048576, 1002236],
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

check('the reserve scales with the window, and is still bounded', () => {
  // The flat part of the curve: the 25 % band and the MIN clamp, unchanged.
  assert.equal(computeCompactionReserveTokens(8192), 2048);
  // The MIN clamp: 25 % of 4096 is 1024, below the 1500 floor.
  assert.equal(computeCompactionReserveTokens(4096), 1500);
  // The √ reply budget: 8192 tokens at the 32k reference window, growing with
  // the square root of the window from there. The old flat 13 000-token
  // ceiling left only 1.2 % of a 1M window for the reply.
  assert.equal(computeCompactionReserveTokens(65536), 13000);
  assert.equal(computeCompactionReserveTokens(131072), 16384);
  assert.equal(computeCompactionReserveTokens(262144), 23170);
  assert.equal(computeCompactionReserveTokens(1048576), 46340);
  // The WINDOW cap: the clamp alone would reserve 1500 of 2048 tokens (73 %),
  // so compaction would fire almost constantly — and the pipeline cannot fit
  // its own short prompt in what would be left.
  assert.equal(computeCompactionReserveTokens(2048), 819);
  assert.ok(
    computeCompactionReserveTokens(2048) < 1500,
    'the 40 % window cap is not being applied'
  );
});

/**
 * The reserve formula this change replaces, computed the old way.
 *
 * WHY it is recomputed HERE rather than imported: the point of the sweep
 * below is to prove that the new formula agrees with the old one over the
 * whole range where it must agree, and a comparison against the new formula
 * would prove nothing.
 *
 * @param {number} numCtx - the context window.
 * @returns {number} the reserve the old formula produced.
 */
function oldReserveTokens(numCtx) {
  const clamped = Math.max(
    COMPACT_RESERVE_MIN_TOKENS,
    Math.min(COMPACT_RESERVE_MAX_TOKENS, Math.floor(numCtx * COMPACT_RESERVE_RATIO))
  );
  return Math.min(clamped, Math.floor(numCtx * COMPACT_RESERVE_MAX_WINDOW_RATIO));
}

/**
 * The last window at which the new reserve still equals the old one.
 *
 * WHY it is pinned and not computed: the √ reply ceiling reaches 13 001
 * tokens at 82 533, so that is the first window whose reserve moves. A
 * COMPUTED crossover would compare the new formula with itself and prove
 * nothing.
 */
const RESERVE_CROSSOVER_WINDOW = 82_532;

check('the reserve is unchanged for every window at or below the crossover', () => {
  // The tuned 8k/32k cases and every smaller window must not move: the √
  // ceiling is below the old flat 13 000-token ceiling all the way up to
  // 82 532 tokens.
  for (let numCtx = 512; numCtx <= RESERVE_CROSSOVER_WINDOW; numCtx += 1) {
    const actual = computeCompactionReserveTokens(numCtx);
    const expected = oldReserveTokens(numCtx);
    if (actual !== expected) {
      assert.equal(
        actual,
        expected,
        `the reserve moved at numCtx ${numCtx}: ${actual}, expected ${expected}`
      );
    }
  }
  // And the crossover is EXACT: the √ ceiling reaches 13 001 at 82 533, so
  // that is the first window whose reserve grows.
  assert.equal(
    computeCompactionReserveTokens(RESERVE_CROSSOVER_WINDOW),
    COMPACT_RESERVE_MAX_TOKENS
  );
  assert.equal(
    computeCompactionReserveTokens(RESERVE_CROSSOVER_WINDOW + 1),
    COMPACT_RESERVE_MAX_TOKENS + 1
  );
});

check('the trigger never goes backwards and the reply room never shrinks', () => {
  let previousTrigger = -1;
  let previousRoom = -1;
  for (let numCtx = 512; numCtx <= 1048576; numCtx += 1) {
    const trigger = computeCompactionTriggerTokens(numCtx);
    const room = numCtx - trigger;
    if (trigger < previousTrigger) {
      assert.equal(
        trigger,
        previousTrigger,
        `the trigger went backwards at numCtx ${numCtx}: ${previousTrigger} → ${trigger}`
      );
    }
    if (room < previousRoom) {
      assert.equal(
        room,
        previousRoom,
        `the reply room shrank at numCtx ${numCtx}: ${previousRoom} → ${room}`
      );
    }
    previousTrigger = trigger;
    previousRoom = room;
  }
});

check('the reserve is never more than 40 % of the window', () => {
  for (let numCtx = 512; numCtx <= 1048576; numCtx += 1) {
    const reserve = computeCompactionReserveTokens(numCtx);
    if (reserve > Math.floor(numCtx * COMPACT_RESERVE_MAX_WINDOW_RATIO)) {
      assert.equal(
        reserve,
        Math.floor(numCtx * COMPACT_RESERVE_MAX_WINDOW_RATIO),
        `the reserve ${reserve} is more than 40 % of the window at numCtx ${numCtx}`
      );
    }
  }
});

check('the trigger never exceeds 97 % of the window', () => {
  for (let numCtx = 512; numCtx <= 1048576; numCtx += 1) {
    const trigger = computeCompactionTriggerTokens(numCtx);
    if (trigger > Math.floor(numCtx * 0.97)) {
      assert.equal(
        trigger,
        Math.floor(numCtx * 0.97),
        `the trigger ${trigger} is above 97 % of the window at numCtx ${numCtx}`
      );
    }
  }
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

console.log('the distiller input and digest caps scale with the window');

/**
 * The INPUT cap each context window has to produce, in characters.
 *
 * The cap used to be `min(50 000, numCtx * 8)` CHARACTERS: the `min` bound
 * for every window at or above 6250 (so a 500 KB tool result was cut to 10 %
 * before the distiller saw it at 256k and at 1M alike), and `numCtx * 8`
 * characters is about `numCtx * 2` tokens — TWICE the window at small sizes.
 *
 * It is now a token budget converted at the CONSERVATIVE 3.5 characters per
 * token (the Llama/Qwen tokenizers this feature exists for run at 3.0-3.5),
 * and it is bounded by an ABSOLUTE ceiling of 112 000 characters (32 000
 * tokens — a quarter of a 128k-token provider limit), because the window
 * Locopilot believes is not the window the provider enforces.
 */
const DISTILL_INPUT_CAP_TABLE = [
  [2048, 2688],
  [8192, 14336],
  [32768, 57344],
  [65536, 112000],
  [131072, 112000],
  [262144, 112000],
  [1048576, 112000],
];

/**
 * The DIGEST cap each context window has to produce, in characters.
 *
 * The digest is the MODEL'S ANSWER, so its cap is the larger of the model's
 * output capacity and the window's share — and it must never be the thing
 * that cuts the answer. At every window up to ~257 000 tokens the MODEL'S
 * OUTPUT LIMIT binds (5140 characters); above it the WINDOW SHARE binds.
 */
const DISTILL_DIGEST_CAP_TABLE = [
  [2048, 5140],
  [8192, 5140],
  [32768, 5140],
  [131072, 5140],
  [262144, 5242],
  [1048576, 20971],
];

/**
 * The MODEL'S OUTPUT LIMIT each context window has to produce, in tokens.
 *
 * The digest's size is set by what the model can emit, so the limit has to
 * scale with the window for "the digest scales with the window" to be true
 * at all: `clamp(floor(numCtx / 256), 1024, 4096)`.
 */
const DISTILL_NUM_PREDICT_TABLE = [
  [2048, 1024],
  [8192, 1024],
  [32768, 1024],
  [131072, 1024],
  [262144, 1024],
  [524288, 2048],
  [1048576, 4096],
];

/**
 * WHICH of the two bounds the digest cap is at each window: the MODEL's
 * OUTPUT LIMIT or the WINDOW SHARE.
 */
const DISTILL_DIGEST_BINDING_TABLE = [
  [8192, 'output'],
  [32768, 'output'],
  [131072, 'output'],
  [262144, 'window'],
  [1048576, 'window'],
];

check('the distiller input cap scales with the window', () => {
  for (const [numCtx, expected] of DISTILL_INPUT_CAP_TABLE) {
    assert.equal(
      computeDistillInputMaxChars(numCtx),
      expected,
      `a ${numCtx}-token window sends at most ${computeDistillInputMaxChars(numCtx)} chars, expected ${expected}`
    );
  }
});

check('the distiller input cap never exceeds the absolute ceiling', () => {
  // The provider's real input limit may be LOWER than the window Locopilot
  // believes (the OpenAI-compatible adapter never sends `num_ctx`), so a
  // window-derived cap alone can send a request the provider rejects — and a
  // rejected call leaves the tool output VERBATIM, which is what the
  // distillation exists to prevent.
  for (let numCtx = 512; numCtx <= 1048576; numCtx += 997) {
    const cap = computeDistillInputMaxChars(numCtx);
    assert.ok(
      cap <= TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE,
      `at numCtx ${numCtx} the input cap is ${cap}, over the ${TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE}-char ceiling`
    );
  }
  assert.equal(TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE, 112000);
  // The ceiling is a QUARTER of a 128k-token provider limit, at the
  // distiller's conservative 3.5 characters per token.
  assert.equal(
    Math.floor(TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE / DISTILL_CHARS_PER_TOKEN),
    32000,
    'the absolute ceiling is not 32 000 tokens'
  );
  assert.ok(32000 * 4 <= 128000, 'the ceiling is more than a quarter of a 128k provider limit');
});

check('the distiller input never exceeds the window it is sent to', () => {
  // The implied token count (characters / 3.5, the CONSERVATIVE conversion)
  // has to leave room for the distiller's OWN answer and the request's own
  // overhead. The old `numCtx * 8` cap allowed 4096 tokens at a 2048-token
  // window: the distillation request itself 400ed and the output stayed
  // verbatim.
  for (let numCtx = 1792; numCtx <= 1048576; numCtx += 1) {
    const implied = computeDistillInputMaxChars(numCtx) / DISTILL_CHARS_PER_TOKEN;
    const limit = numCtx - computeDistillNumPredict(numCtx) - TOOL_DISTILL_INPUT_OVERHEAD_TOKENS;
    if (implied > limit) {
      assert.equal(
        implied,
        limit,
        `the distiller input is ${implied} tokens at numCtx ${numCtx}, over the ${limit}-token limit`
      );
    }
  }
  // Below 1792 tokens the FLOOR of 512 tokens binds, and a window that small
  // cannot host the distiller's own 1024-token answer anyway.
  assert.equal(computeDistillInputMaxChars(1792), Math.floor(512 * DISTILL_CHARS_PER_TOKEN));
});

check("the distiller's characters-per-token conversion is CONSERVATIVE", () => {
  // The shared 4-characters-per-token estimate is optimistic for exactly the
  // models that need the scaling: Llama and Qwen tokenizers run at roughly
  // 3.0-3.5 characters per token, so a 2 000 000-character output is really
  // 570 000-670 000 tokens — 57-67 % of a 1M window, not 50 %.
  assert.equal(DISTILL_CHARS_PER_TOKEN, 3.5);
  assert.ok(
    DISTILL_CHARS_PER_TOKEN < 4,
    'the distiller is back to the optimistic 4-characters-per-token conversion'
  );
  // And the cap really is smaller than the optimistic conversion would make
  // it: the same token budget, fewer characters.
  const tokenBudget = 16384;
  assert.ok(
    computeDistillInputMaxChars(32768) < tokenBudget * 4,
    'the input cap is not smaller than the optimistic conversion would give'
  );
  assert.equal(computeDistillInputMaxChars(32768), Math.floor(tokenBudget * 3.5));
});

check("the distiller's output limit scales with the window", () => {
  for (const [numCtx, expected] of DISTILL_NUM_PREDICT_TABLE) {
    assert.equal(
      computeDistillNumPredict(numCtx),
      expected,
      `a ${numCtx}-token window lets the distiller write ${computeDistillNumPredict(numCtx)} tokens, expected ${expected}`
    );
  }
  // The floor and the ceiling hold at every window.
  for (let numCtx = 512; numCtx <= 1048576; numCtx += 1009) {
    const limit = computeDistillNumPredict(numCtx);
    assert.ok(
      limit >= TOOL_DISTILL_NUM_PREDICT_BASE && limit <= TOOL_DISTILL_NUM_PREDICT_MAX,
      `at numCtx ${numCtx} the output limit is ${limit}`
    );
  }
  // And it never grows by more than one token per 256 tokens of window.
  for (let numCtx = 512; numCtx <= 1048576; numCtx += 1) {
    const limit = computeDistillNumPredict(numCtx);
    assert.ok(
      limit <= TOOL_DISTILL_NUM_PREDICT_BASE + Math.ceil(numCtx / 256),
      `at numCtx ${numCtx} the output limit is ${limit}`
    );
  }
});

check('the digest cap scales with the window', () => {
  for (const [numCtx, expected] of DISTILL_DIGEST_CAP_TABLE) {
    assert.equal(
      computeDistillDigestMaxChars(numCtx),
      expected,
      `a ${numCtx}-token window allows a ${computeDistillDigestMaxChars(numCtx)}-char digest, expected ${expected}`
    );
  }
});

check('the digest cap NEVER cuts the model answer', () => {
  // The digest IS the model's answer. A cap below what the model can emit
  // cuts it mid-sentence, and a digest that stops mid-sentence carries no
  // signal that it was cut — the summariser then copies a fragment as if it
  // were the whole value. The old flat 2400-character cap did exactly that
  // at every window up to ~205 000 tokens.
  for (let numCtx = 512; numCtx <= 1048576; numCtx += 331) {
    const cap = computeDistillDigestMaxChars(numCtx);
    const capacity =
      computeDistillNumPredict(numCtx) * DISTILL_OUTPUT_CHARS_PER_TOKEN +
      TOOL_DISTILL_TRUNCATION_MARKER.length;
    assert.ok(
      cap >= capacity,
      `at numCtx ${numCtx} the digest cap is ${cap}, below the ${capacity}-char output capacity`
    );
    assert.ok(
      cap <= TOOL_DISTILL_DIGEST_MAX_CHARS_CEILING,
      `at numCtx ${numCtx} the digest cap is ${cap}`
    );
  }
  assert.ok(
    TOOL_DISTILL_DIGEST_MAX_CHARS_CEILING >
      TOOL_DISTILL_NUM_PREDICT_MAX * DISTILL_OUTPUT_CHARS_PER_TOKEN +
        TOOL_DISTILL_TRUNCATION_MARKER.length,
    'the digest ceiling is below the largest output capacity — it would cut the answer'
  );
});

check('the digest cap is never the old flat 2400 characters', () => {
  // The regression the whole change exists for: the flat 2400-character
  // digest is what the tuned small windows were measured against, and it is
  // BELOW what the model can emit at every one of them — so it cut the
  // model's answer in half.
  for (const numCtx of [512, 1024, 2048, 4096, 8192, 16384, 32768]) {
    const cap = computeDistillDigestMaxChars(numCtx);
    assert.ok(
      cap > 2400,
      `a ${numCtx}-token window allows a ${cap}-char digest — the old flat cap is back`
    );
  }
});

check('which of the two bounds the digest cap is, at each window', () => {
  for (const [numCtx, expected] of DISTILL_DIGEST_BINDING_TABLE) {
    const capacity =
      computeDistillNumPredict(numCtx) * DISTILL_OUTPUT_CHARS_PER_TOKEN +
      TOOL_DISTILL_TRUNCATION_MARKER.length;
    const share = Math.floor(numCtx * TOOL_DISTILL_MAX_CHARS_WINDOW_RATIO);
    const binding = share > capacity ? 'window' : 'output';
    assert.equal(
      binding,
      expected,
      `at numCtx ${numCtx} the ${binding} bound binds (capacity ${capacity}, share ${share})`
    );
    // The cap is the LARGER of the two — the point of the whole fix.
    assert.equal(computeDistillDigestMaxChars(numCtx), Math.max(capacity, share));
  }
});

console.log('the distiller tells the truth about what it cut');

check('a truncated input says how much of it was sent, and fits in the cap', () => {
  const content = 'x'.repeat(5000);
  const cap = 1000;
  const result = truncateToolOutputForDistillation(content, cap);
  assert.equal(result.truncated, true, 'the cut was not reported');
  assert.equal(result.totalChars, 5000);
  assert.ok(result.keptChars > 0, 'nothing was kept');
  assert.ok(result.keptChars < cap, 'the kept count is not inside the cap');
  // The marker counts towards the cap: the result never exceeds it.
  assert.ok(
    result.text.length <= cap,
    `the truncated input is ${result.text.length} chars, over the ${cap}-char cap`
  );
  // The kept count is the SLICE, not the raw length.
  assert.equal(result.text.slice(0, result.keptChars), 'x'.repeat(result.keptChars));
  assert.ok(
    result.text.includes(`only the first ${result.keptChars} of 5000 characters`),
    `the marker does not name the kept count: ${result.text.slice(-200)}`
  );
  assert.ok(
    result.text.includes(`the remaining ${5000 - result.keptChars} characters were NOT included`),
    `the marker does not name the dropped count: ${result.text.slice(-200)}`
  );
  assert.match(
    result.text,
    /\[\.\.\.truncated: only the first \d+ of 5000 characters of this tool output were sent to the distiller; the remaining \d+ characters were NOT included]$/
  );
});

check('an output that fits is sent whole and unmarked', () => {
  const result = truncateToolOutputForDistillation('abc', 1000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, 'abc');
  assert.equal(result.keptChars, 3);
  assert.equal(result.totalChars, 3);
});

check('a zero-length output is skipped, not marked', () => {
  const result = truncateToolOutputForDistillation('', 1000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, '');
  assert.equal(result.keptChars, 0);
  assert.equal(result.totalChars, 0);
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

console.log('the distillation prefill budget bounds the whole compaction');

/**
 * The prefill budget each context window has to produce, in tokens.
 *
 * The budget is what keeps ONE compaction's distillation from costing
 * several windows' worth of prefill: the call cap bounds how MANY calls
 * there are, and the budget bounds what they may COST.
 */
const DISTILL_PREFILL_BUDGET_TABLE = [
  [2048, 2048],
  [8192, 8192],
  [32768, 32768],
  [131072, 131072],
  [1048576, 1048576],
];

check('the prefill budget is one window of tokens', () => {
  for (const [numCtx, expected] of DISTILL_PREFILL_BUDGET_TABLE) {
    assert.equal(
      computeDistillPrefillBudgetTokens(numCtx),
      expected,
      `a ${numCtx}-token window budgets ${computeDistillPrefillBudgetTokens(numCtx)} prefill tokens, expected ${expected}`
    );
  }
  assert.equal(TOOL_DISTILL_PREFILL_BUDGET_WINDOW_RATIO, 1);
  // A window that is not known still gets a usable budget — a budget of zero
  // would silently disable the distillation for every such caller.
  for (const numCtx of [0, -8192, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(
      computeDistillPrefillBudgetTokens(numCtx) > 0,
      `a window of ${numCtx} got a budget of ${computeDistillPrefillBudgetTokens(numCtx)}`
    );
  }
});

check('a plan over many oversized results never exceeds the budget', () => {
  // The regression the budget exists for: the per-call input grew 40x, so
  // eight calls at half a million tokens each is ~4M tokens of prefill
  // inside ONE compaction — several times the window it is trying to shrink.
  const sizes = [900_000, 800_000, 700_000, 600_000, 500_000, 400_000, 300_000, 200_000, 100_000];
  const history = distillFixture(sizes);
  const plan = planDistillation(history, TOOL_DISTILL_MAX_CALLS);
  assert.equal(plan.selected.length, TOOL_DISTILL_MAX_CALLS);

  for (const numCtx of [8192, 32768, 131072, 262144, 1048576]) {
    const budget = createDistillBudget(numCtx);
    const calls = planDistillCalls(
      history,
      plan.selected,
      computeDistillInputMaxChars(numCtx),
      budget.totalTokens - budget.usedTokens
    );
    assert.ok(
      calls.prefillTokens <= budget.totalTokens,
      `at numCtx ${numCtx} the plan spends ${calls.prefillTokens} prefill tokens of a ${budget.totalTokens}-token budget`
    );
    // And every call is affordable on its own.
    for (const call of calls.calls) {
      assert.ok(
        call.prefillTokens <= budget.totalTokens,
        `one call costs ${call.prefillTokens} tokens of a ${budget.totalTokens}-token budget`
      );
    }
  }
});

check('the budget is spent on the LARGEST results first', () => {
  // The biggest outputs are the ones that decide whether the compacted
  // history fits, and they are the most expensive to distil — so they are
  // the ones worth the budget.
  const sizes = [900_000, 800_000, 700_000, 600_000];
  const history = distillFixture(sizes);
  const plan = planDistillation(history, TOOL_DISTILL_MAX_CALLS);
  const perCall = computeDistillInputMaxChars(131072);
  const calls = planDistillCalls(history, plan.selected, perCall, 40_000);
  assert.ok(calls.calls.length > 0, 'the budget stopped everything');
  assert.ok(
    calls.calls.length < plan.selected.length,
    'the budget stopped nothing — the fixture is too small'
  );
  // The first call (largest first) is the biggest output, and the ones that
  // were dropped are the SMALLER ones.
  assert.equal(calls.calls[0].index, toolIndex(0));
  assert.ok(calls.budgetSkipped > 0, 'the budget stopped nothing');
  const dropped = plan.selected.filter(
    (index) => !calls.calls.some((call) => call.index === index)
  );
  for (const index of dropped) {
    assert.ok(
      index > calls.calls.at(-1).index,
      'a SMALLER output was dropped while a bigger one was kept'
    );
  }
});

check('the progress data is derivable from the plan', () => {
  // The progress line reports "distilled N of M outputs (~T tokens of
  // prefill; the budget stopped at K)" — so the numbers it needs have to
  // exist: the candidates, the calls, the prefill and the budget stops.
  const sizes = [50_000, 40_000, 30_000, 20_000, 10_000];
  const history = distillFixture(sizes);
  const plan = planDistillation(history, TOOL_DISTILL_MAX_CALLS);
  const budget = createDistillBudget(32768);
  const calls = planDistillCalls(
    history,
    plan.selected,
    computeDistillInputMaxChars(32768),
    budget.totalTokens - budget.usedTokens
  );
  const candidates = plan.selected.length + plan.skipped;
  assert.equal(candidates, sizes.length);
  assert.ok(calls.calls.length <= plan.selected.length);
  assert.equal(calls.budgetSkipped, plan.selected.length - calls.calls.length);
  assert.equal(
    calls.prefillTokens,
    calls.calls.reduce((total, call) => total + call.prefillTokens, 0),
    'the reported prefill is not the sum of the calls'
  );
  // The budget is spent, not exceeded: what is left is never negative.
  assert.ok(budget.totalTokens - calls.prefillTokens >= 0, 'the budget went negative');
});

check('the prefill estimate is conservative', () => {
  assert.equal(estimateDistillPrefillTokens(0), 0);
  assert.equal(estimateDistillPrefillTokens(-10), 0);
  assert.equal(estimateDistillPrefillTokens(3500), 1000);
  // It never UNDER-counts: 3.5 characters per token is the conservative side.
  assert.ok(
    estimateDistillPrefillTokens(112000) >= 32000,
    'the prefill estimate under-counts the absolute ceiling'
  );
  assert.equal(estimateDistillPrefillTokens(112000), 32000);
});

console.log('the distillation call has a timeout');

check('the timeout scales with the request and is bounded', () => {
  // The request used to carry NO timeout, so a slow prefill could hang the
  // compaction for ever.
  const small = computeDistillTimeoutMs(768, 1024);
  const large = computeDistillTimeoutMs(32_000, 4096);
  assert.ok(small < large, `a small request (${small}) is not faster than a large one (${large})`);
  assert.ok(small >= TOOL_DISTILL_TIMEOUT_BASE_MS, `the floor is ${TOOL_DISTILL_TIMEOUT_BASE_MS}`);
  assert.ok(large <= TOOL_DISTILL_TIMEOUT_MAX_MS, `the ceiling is ${TOOL_DISTILL_TIMEOUT_MAX_MS}`);
  // And it never leaves the band, whatever it is asked.
  for (let tokens = 0; tokens <= 200_000; tokens += 997) {
    for (const output of [1024, 2048, 4096]) {
      const timeout = computeDistillTimeoutMs(tokens, output);
      assert.ok(
        timeout >= TOOL_DISTILL_TIMEOUT_BASE_MS && timeout <= TOOL_DISTILL_TIMEOUT_MAX_MS,
        `a ${tokens}-token request with a ${output}-token answer timed out after ${timeout}ms`
      );
    }
  }
});

check('the timeout is never shorter than the base and never longer than the ceiling', () => {
  assert.equal(computeDistillTimeoutMs(0, 0), TOOL_DISTILL_TIMEOUT_BASE_MS + 0);
  assert.equal(computeDistillTimeoutMs(0, 1024), TOOL_DISTILL_TIMEOUT_BASE_MS + 60_000);
  assert.equal(
    computeDistillTimeoutMs(1_000, 1024),
    TOOL_DISTILL_TIMEOUT_BASE_MS + 20_000 + 60_000
  );
  assert.equal(
    computeDistillTimeoutMs(1_000_000, 4096),
    TOOL_DISTILL_TIMEOUT_MAX_MS,
    'a huge request is not clamped to the ceiling'
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
    // Not silent: one line names how many calls failed AND why, because a
    // failed call leaves the tool output VERBATIM — the thing the
    // distillation existed to prevent.
    const reported = progress.filter((line) => /tool distillation call\(s\) failed/.test(line));
    assert.equal(
      reported.length,
      1,
      `the failure was not reported once: ${JSON.stringify(progress)}`
    );
    assert.match(reported[0], /2 of 2 tool distillation call\(s\) failed/);
    assert.match(reported[0], /stay verbatim/);
    assert.match(reported[0], /\(.+\)/, 'the failure line does not name a reason');
    // And the pass reports what it did as well as what it could not do.
    assert.equal(result.attemptedCount, 2, 'the pass did not report the calls it made');
    assert.equal(result.candidateCount, 2, 'the pass did not report its candidates');
    assert.ok(result.prefillTokens > 0, 'the pass charged nothing for its prefill');
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

await checkAsync('the budget stops the calls it cannot pay for', async () => {
  // A budget of one token cannot pay for a single call, so NOTHING is
  // distilled and every candidate is reported as left behind — the output
  // stays verbatim, which is the honest outcome.
  const history = distillFailureFixture();
  const budget = { totalTokens: 1, usedTokens: 0 };
  const progress = [];
  const result = await distillToolMessages(
    REFUSING_CTX,
    history,
    8192,
    MODEL,
    2,
    (message) => progress.push(message),
    undefined,
    undefined,
    undefined,
    budget
  );
  assert.equal(result.distilledCount, 0, 'a call was made with no budget');
  assert.equal(result.attemptedCount, 0, 'a call was made with no budget');
  assert.equal(result.budgetSkippedCount, 2, 'the budget did not report what it stopped');
  assert.equal(result.prefillTokens, 0, 'the plan charged for calls it did not make');
  assert.deepEqual(
    result.messages.map((entry) => entry.content),
    history.map((entry) => entry.content),
    'a budgeted-out output changed the history'
  );
  assert.ok(
    progress.some((line) => /prefill budget ran out/.test(line)),
    `the budget stop was not reported: ${JSON.stringify(progress)}`
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

console.log('the recent-files stub budget');

check('the stub budget never exceeds the window share or the flat cap', () => {
  // The stub is paid for out of the context the compaction just freed, so it
  // can never be more than a tenth of the window — and never more than the flat
  // 5000-token cap, whichever is smaller.
  for (const numCtx of CONTEXT_SIZES) {
    const ceiling = Math.min(
      RECENT_FILES_MAX_TOTAL_TOKENS,
      Math.floor(numCtx * RECENT_FILES_MAX_WINDOW_RATIO)
    );
    for (const old of [0, 500, 5000, 100_000, 1_000_000]) {
      const budget = computeRecentFilesBudget({
        numCtx,
        acceptanceBudget: Math.floor(numCtx * 0.9),
        oldTokenCount: old,
        headerTokens: 0,
        windowTokens: 0,
        systemPromptTokens: 0,
      });
      assert.ok(
        budget <= ceiling,
        `the budget ${budget} at numCtx ${numCtx}, old ${old} exceeds the ${ceiling}-token ceiling`
      );
    }
  }
});

check('the stub budget can never make the result no smaller than its input', () => {
  // THE load-bearing property: `evaluateCompactionSizes` ABORTS a compaction
  // whose result is not smaller than its input, so a stub that ate the whole
  // acceptance budget on a history that was not near it would turn a successful
  // compaction into a thrown error. The stub's room is therefore bounded by
  // `min(acceptanceBudget, old - 1)`, minus everything the result already
  // carries and minus the stub's own message framing.
  for (const numCtx of [1024, 2048, 4096, 8192, 32768, 131072]) {
    const acceptanceBudget = Math.floor(numCtx * 0.9);
    for (const old of [0, 1, 2, 150, 1000, 5000, 20_000, 200_000, 2_000_000]) {
      for (const [headerTokens, windowTokens, systemPromptTokens] of [
        [0, 0, 0],
        [600, 3000, 1500],
        [2000, 10_000, 4000],
        [50, 20, 30],
      ]) {
        const budget = computeRecentFilesBudget({
          numCtx,
          acceptanceBudget,
          oldTokenCount: old,
          headerTokens,
          windowTokens,
          systemPromptTokens,
        });
        if (budget === 0) {
          // Zero is always safe: no stub is emitted at all.
          continue;
        }
        assert.ok(
          Number.isInteger(budget) && budget >= RECENT_FILES_MIN_TOKENS,
          `a budget of ${budget} is neither zero nor a usable size (numCtx ${numCtx}, old ${old})`
        );
        // Everything the result would carry if the stub spent its whole budget:
        // the charges, the 8-token framing, and the budget itself. It has to
        // stay strictly under the OLD size or the abort guard fires.
        const worstCase = headerTokens + windowTokens + systemPromptTokens + 8 + budget;
        assert.ok(
          worstCase < old,
          `the stub could push the result to ${worstCase} against an old size of ${old} ` +
            `(numCtx ${numCtx}, charges ${headerTokens}/${windowTokens}/${systemPromptTokens})`
        );
        assert.ok(
          worstCase <= acceptanceBudget,
          `the stub could push the result past the acceptance boundary at numCtx ${numCtx}`
        );
      }
    }
  }
});

check('the stub budget is zero when the existing charges already exceed it', () => {
  const acceptanceBudget = Math.floor(8192 * 0.9);
  for (const charges of [
    { headerTokens: 4000, windowTokens: 5000, systemPromptTokens: 2000 },
    { headerTokens: acceptanceBudget, windowTokens: 0, systemPromptTokens: 0 },
    { headerTokens: 0, windowTokens: 0, systemPromptTokens: acceptanceBudget + 1 },
    // The history was already tighter than the acceptance boundary.
    { headerTokens: 100, windowTokens: 100, systemPromptTokens: 100 },
  ]) {
    const oldTokenCount = charges.headerTokens === 100 ? 400 : 1_000_000;
    assert.equal(
      computeRecentFilesBudget({ numCtx: 8192, acceptanceBudget, oldTokenCount, ...charges }),
      0,
      `a stub was planned with charges ${JSON.stringify(charges)} against old ${oldTokenCount}`
    );
  }
});

check('the ceiling bounds the MESSAGE, framing included', () => {
  // The budget is a budget for the stub's TEXT, and the message that carries it
  // costs 5 tokens more (a message base plus the role name). The ceiling used to
  // be applied to the text alone, so a stub at its full budget overran by the
  // framing — measured at 2 tokens on a real plan, 5 in the worst case.
  const framing =
    countMessageTokens({ role: 'assistant', content: 'a' }, MODEL) - countTextTokens('a', MODEL);
  assert.equal(
    framing,
    RECENT_FILES_MESSAGE_FRAMING_TOKENS,
    'the framing constant no longer matches what the tokenizer charges'
  );

  for (const numCtx of CONTEXT_SIZES) {
    const ceiling = Math.min(
      RECENT_FILES_MAX_TOTAL_TOKENS,
      Math.floor(numCtx * RECENT_FILES_MAX_WINDOW_RATIO)
    );
    const acceptanceBudget = Math.floor(numCtx * 0.9);
    for (const old of [0, 500, 5000, 100_000, 1_000_000]) {
      for (const [headerTokens, windowTokens, systemPromptTokens] of [
        [0, 0, 0],
        [600, 3000, 1500],
        [50, 20, 30],
      ]) {
        const budget = computeRecentFilesBudget({
          numCtx,
          acceptanceBudget,
          oldTokenCount: old,
          headerTokens,
          windowTokens,
          systemPromptTokens,
        });
        if (budget === 0) continue;
        assert.ok(
          budget + framing <= ceiling,
          `a stub of ${budget} text tokens costs ${budget + framing} with its framing, ` +
            `over the ${ceiling}-token ceiling (numCtx ${numCtx})`
        );
        // The saving bound is now stricter by the same amount, because the
        // framing has to fit inside it too.
        const worstCase =
          headerTokens +
          windowTokens +
          systemPromptTokens +
          RECENT_FILES_MESSAGE_OVERHEAD_TOKENS +
          budget +
          framing;
        assert.ok(
          worstCase < old || old === 0,
          `the stub could push the result to ${worstCase} against an old size of ${old}`
        );
        assert.ok(
          worstCase <= acceptanceBudget,
          `the stub could push the result past the acceptance boundary at numCtx ${numCtx}`
        );
      }
    }
  }
});

check('the floor is above the cheapest stub that is worth emitting', () => {
  // 150 used to be the floor, and the cheapest mandatory stub (header + five
  // path-only bullets + end marker) measured 176 — so the band 150–176 bought
  // nothing while the comment claimed it did. The floor now covers the
  // measured cost of five path-only bullets at ~80-character paths (~280
  // tokens), and `test-compact-recent-files` proves a budget of exactly the
  // floor really buys that stub.
  assert.ok(
    RECENT_FILES_MIN_TOKENS >= 280,
    `the floor is ${RECENT_FILES_MIN_TOKENS}, below the measured mandatory stub`
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
