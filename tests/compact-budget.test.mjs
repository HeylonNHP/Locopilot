/**
 * Tests for the compaction pipeline's BUDGET arithmetic and for the
 * termination of the map-reduce reduction.
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

import { describe, expect, test } from '@jest/globals';
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
  TOOL_DISTILL_EXTRA_CALLS_MAX,
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
  planDistillPass,
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

/**
 * An LLM context whose calls fail at the TRANSPORT layer (port 1 refuses the
 * connection immediately) — no network, no quota, no model.
 *
 * WHY it lives at the top of the file: it is a CONST, and a const is in its
 * temporal dead zone until its declaration is evaluated — so a check that
 * used it above the declaration would fail with a ReferenceError rather
 * than with an assertion.
 */
const REFUSING_CTX = { baseUrl: 'http://127.0.0.1:1' };

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

describe('the effective input budget', () => {
  test.each(CONTEXT_SIZES)('the prompt is charged at every context size (%p)', (numCtx) => {
    const safe = computeSafeInputBudget(numCtx);
    const promptTokens = 400;
    const allowance = computeEffectiveInputBudget(safe, promptTokens);
    expect(allowance).toBe(Math.max(0, safe - promptTokens));
  });

  test('the allowance is never the old 256 floor', () => {
    // The old code returned `max(256, safe - prompt)`, so a small budget
    // silently GREW back to 256 tokens and the prompt was charged nothing.
    for (const [safe, promptTokens] of [
      [100, 40],
      [256, 10],
      [307, 300],
      [614, 600],
    ]) {
      const allowance = computeEffectiveInputBudget(safe, promptTokens);
      expect(allowance).toBeLessThan(256);
      expect(allowance).toBe(Math.max(0, safe - promptTokens));
    }
    // And the subtraction is never raised anywhere: the allowance is always
    // the subtraction (floored at zero), never more.
    for (const numCtx of CONTEXT_SIZES) {
      const safe = computeSafeInputBudget(numCtx);
      const promptTokens = countSummarisationPromptTokens(PROMPT_PARAMS, MODEL);
      expect(computeEffectiveInputBudget(safe, promptTokens)).toBe(
        Math.max(0, safe - promptTokens)
      );
    }
  });

  test('the allowance is floored at zero, never negative', () => {
    expect(computeEffectiveInputBudget(100, 400)).toBe(0);
    expect(computeEffectiveInputBudget(0, 0)).toBe(0);
    expect(computeEffectiveInputBudget(1000, 400)).toBe(600);
  });

  test('the measured prompt costs are subtracted from the budget', () => {
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
    expect(fullTokens).toBeGreaterThan(0);
    expect(shortTokens).toBeGreaterThan(0);
    expect(shortTokens).toBeLessThan(fullTokens);
    expect(computeEffectiveInputBudget(safe, fullTokens)).toBe(safe - fullTokens);
    expect(computeEffectiveInputBudget(safe, shortTokens)).toBe(safe - shortTokens);
  });
});

describe('the prompt mode at a small context window', () => {
  test('a large context window uses the full prompt', () => {
    const safe = computeSafeInputBudget(8192);
    const plan = planSummarisationPrompt(safe, MODEL, PROMPT_PARAMS);
    expect(plan).toBeTruthy();
    expect(plan.mode).toBe('full');
    expect(plan.historyBudget).toBe(safe - plan.promptTokens);
  });

  test('a small context window falls back to the short prompt', () => {
    const safe = computeSafeInputBudget(2048);
    const plan = planSummarisationPrompt(safe, MODEL, { ...PROMPT_PARAMS, numCtx: 2048 });
    expect(plan).toBeTruthy();
    expect(plan.mode).toBe('short');
    // The short prompt must leave MORE room for the history than the full one.
    const fullHistory = computeEffectiveInputBudget(
      safe,
      countSummarisationPromptTokens({ ...PROMPT_PARAMS, numCtx: 2048 }, MODEL)
    );
    expect(plan.historyBudget).toBeGreaterThan(fullHistory);
  });

  test('the chunked path is budgeted for its extra prompt sentence', () => {
    const safe = computeSafeInputBudget(8192);
    const plan = planSummarisationPrompt(safe, MODEL, PROMPT_PARAMS);
    expect(plan).toBeTruthy();
    expect(plan.chunkHistoryBudget).toBeLessThanOrEqual(plan.historyBudget);
    expect(plan.historyBudget - plan.chunkHistoryBudget).toBeLessThan(200);
  });

  test.each([512, 1024])('an impossibly small context window has no plan at all (%p)', (numCtx) => {
    const safe = computeSafeInputBudget(numCtx);
    const plan = planSummarisationPrompt(safe, MODEL, { ...PROMPT_PARAMS, numCtx });
    expect(plan).toBeNull();
  });

  test('the pipeline fails with a clear error at an impossibly small context window', async () => {
    const history = [
      { role: 'user', content: 'the status bar crashes on mount, please fix it' },
      { role: 'assistant', content: 'I will look at the component and patch it.' },
    ];
    // The context is never reached: the budget check fails BEFORE any model
    // call, so this test spends no quota.
    const rejection = produceConversationSummary(
      { baseUrl: 'http://127.0.0.1:1/never-called' },
      MODEL,
      512,
      1,
      history
    );
    await expect(rejection).rejects.toThrow(/too small to compact/i);
    // the error names the context size
    await expect(rejection).rejects.toThrow(/512/);
  });

  test('the short prompt charges the focus note', () => {
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
    expect(withoutFocus && withFocus).toBeTruthy();
    expect(withoutFocus.mode).toBe('short');
    expect(withFocus.mode).toBe('short');

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
    expect(withFocus.promptTokens).toBe(expectedWithFocus);
    const focusCost = expectedWithFocus - withoutFocus.promptTokens;
    expect(focusCost).toBeGreaterThan(50);
    expect(withoutFocus.historyBudget - withFocus.historyBudget).toBe(focusCost);

    // And the charge can be DECISIVE: a note that the old measurement ignored
    // takes the plan from "671 tokens of history" to "no plan at all", because
    // the short prompt would leave too little for the history the summary has to
    // read. The old code happily planned a request 192 tokens over the budget.
    const longFocus = 'keep the auth refactor details and the failing test output, '
      .repeat(15)
      .trim();
    expect(planSummarisationPrompt(safe, MODEL, { ...base, focus: longFocus })).toBeNull();
  });
});

describe('the reduction terminates', () => {
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

  test('an oversized batch still makes progress', () => {
    // Every part is far bigger than the whole parts budget, so the budget
    // check would put ONE part in every batch — the count would not shrink.
    const parts = oversizedParts(51, 4000);
    const partsBudget = 512;
    const batches = batchReductionParts(parts, partsBudget, MODEL);
    expect(batches.length).toBeLessThan(parts.length);
    expect(batches.length).toBeLessThanOrEqual(Math.ceil(parts.length / 2));
  });

  test('every part appears in exactly one batch', () => {
    const parts = oversizedParts(51, 4000);
    const batches = batchReductionParts(parts, 512, MODEL);
    const seen = batches.flatMap((batch) => batch.map((part) => part.number));
    expect(seen.length).toBe(parts.length);
    expect([...seen].sort((left, right) => left - right)).toStrictEqual(
      parts.map((part) => part.number)
    );
  });

  test('the reduction rounds strictly shrink the number of parts and terminate', () => {
    // The regression test for the livelock: the reduction is simulated with
    // the REAL batching helper, and every round has to produce strictly fewer
    // parts. The old code produced the same number of parts for ever.
    let parts = oversizedParts(51, 4000);
    const partsBudget = 512;
    let rounds = 0;
    while (parts.length > 1) {
      rounds += 1;
      expect(rounds).toBeLessThanOrEqual(MAX_REDUCTION_ROUNDS);
      const batches = batchReductionParts(parts, partsBudget, MODEL);
      expect(batches.length).toBeLessThan(parts.length);
      // The worst case: the model answers with a summary as big as the whole
      // batch, so the next round starts from parts that are just as big.
      parts = batches.map((batch, index) => ({
        number: index + 1,
        text: batch.map((part) => part.text).join('\n\n'),
      }));
    }
    expect(rounds).toBeLessThanOrEqual(MAX_REDUCTION_ROUNDS);
    expect(rounds).toBeGreaterThan(0);
  });

  test('the round cap is a hard bound on the reduction', () => {
    expect(MAX_REDUCTION_ROUNDS > 0 && MAX_REDUCTION_ROUNDS <= 16).toBeTruthy();
  });

  test('no part is dropped by the final concatenation', () => {
    const parts = oversizedParts(51, 4000);
    const merged = concatenateReductionParts(parts);
    for (const part of parts) {
      expect(merged).toContain(part.text);
    }
    // Every part is represented exactly once.
    for (const part of parts) {
      const occurrences = merged.split(part.text).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test('the concatenation keeps the six-section shape', () => {
    const parts = [
      { number: 1, text: 'Goal: fix the crash\n\nChanges: src/a.ts was written.' },
      { number: 2, text: 'Goal: and run the tests\n\nKey data: npm test failed.' },
    ];
    const merged = concatenateReductionParts(parts);
    expect(merged).toMatch(/^Goal: /m);
    expect(merged).toMatch(/^Changes: /m);
    expect(merged).toMatch(/^Key data: /m);
    expect(merged).toContain('fix the crash');
    expect(merged).toContain('and run the tests');
    expect(merged).toContain('npm test failed');
  });

  test('a part with no section header is not dropped either', () => {
    const parts = [
      { number: 1, text: 'Goal: fix the crash' },
      { number: 2, text: 'a loose remark with no section header' },
    ];
    const merged = concatenateReductionParts(parts);
    expect(merged).toContain('a loose remark with no section header');
  });
});

describe('the auto-compaction trigger reserves room for the reply', () => {
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

  test('the trigger is the window minus a reserved reply margin', () => {
    for (const [numCtx, expected] of TRIGGER_TABLE) {
      expect(computeCompactionTriggerTokens(numCtx)).toBe(expected);
    }
  });

  test('the reserve scales with the window, and is still bounded', () => {
    // The flat part of the curve: the 25 % band and the MIN clamp, unchanged.
    expect(computeCompactionReserveTokens(8192)).toBe(2048);
    // The MIN clamp: 25 % of 4096 is 1024, below the 1500 floor.
    expect(computeCompactionReserveTokens(4096)).toBe(1500);
    // The √ reply budget: 8192 tokens at the 32k reference window, growing with
    // the square root of the window from there. The old flat 13 000-token
    // ceiling left only 1.2 % of a 1M window for the reply.
    expect(computeCompactionReserveTokens(65536)).toBe(13000);
    expect(computeCompactionReserveTokens(131072)).toBe(16384);
    expect(computeCompactionReserveTokens(262144)).toBe(23170);
    expect(computeCompactionReserveTokens(1048576)).toBe(46340);
    // The WINDOW cap: the clamp alone would reserve 1500 of 2048 tokens (73 %),
    // so compaction would fire almost constantly — and the pipeline cannot fit
    // its own short prompt in what would be left.
    expect(computeCompactionReserveTokens(2048)).toBe(819);
    expect(computeCompactionReserveTokens(2048)).toBeLessThan(1500);
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

  test('the reserve is unchanged for every window at or below the crossover', () => {
    // The tuned 8k/32k cases and every smaller window must not move: the √
    // ceiling is below the old flat 13 000-token ceiling all the way up to
    // 82 532 tokens.
    for (let numCtx = 512; numCtx <= RESERVE_CROSSOVER_WINDOW; numCtx += 1) {
      const actual = computeCompactionReserveTokens(numCtx);
      const expected = oldReserveTokens(numCtx);
      if (actual !== expected) {
        expect(actual).toBe(expected);
      }
    }
    // And the crossover is EXACT: the √ ceiling reaches 13 001 at 82 533, so
    // that is the first window whose reserve grows.
    expect(computeCompactionReserveTokens(RESERVE_CROSSOVER_WINDOW)).toBe(
      COMPACT_RESERVE_MAX_TOKENS
    );
    expect(computeCompactionReserveTokens(RESERVE_CROSSOVER_WINDOW + 1)).toBe(
      COMPACT_RESERVE_MAX_TOKENS + 1
    );
  });

  test('the trigger never goes backwards and the reply room never shrinks', () => {
    let previousTrigger = -1;
    let previousRoom = -1;
    for (let numCtx = 512; numCtx <= 1048576; numCtx += 1) {
      const trigger = computeCompactionTriggerTokens(numCtx);
      const room = numCtx - trigger;
      if (trigger < previousTrigger) {
        expect(trigger).toBe(previousTrigger);
      }
      if (room < previousRoom) {
        expect(room).toBe(previousRoom);
      }
      previousTrigger = trigger;
      previousRoom = room;
    }
  });

  test('the reserve is never more than 40 % of the window', () => {
    for (let numCtx = 512; numCtx <= 1048576; numCtx += 1) {
      const reserve = computeCompactionReserveTokens(numCtx);
      if (reserve > Math.floor(numCtx * COMPACT_RESERVE_MAX_WINDOW_RATIO)) {
        expect(reserve).toBe(Math.floor(numCtx * COMPACT_RESERVE_MAX_WINDOW_RATIO));
      }
    }
  });

  test('the trigger never exceeds 97 % of the window', () => {
    for (let numCtx = 512; numCtx <= 1048576; numCtx += 1) {
      const trigger = computeCompactionTriggerTokens(numCtx);
      if (trigger > Math.floor(numCtx * 0.97)) {
        expect(trigger).toBe(Math.floor(numCtx * 0.97));
      }
    }
  });

  test('the trigger strictly increases with the window', () => {
    const sizes = [
      512, 1024, 2048, 4096, 6000, 8192, 16384, 32768, 131072, 200000, 500000, 1000000,
    ];
    for (let index = 1; index < sizes.length; index += 1) {
      const previous = computeCompactionTriggerTokens(sizes[index - 1]);
      const current = computeCompactionTriggerTokens(sizes[index]);
      expect(current).toBeGreaterThan(previous);
    }
  });

  test('the trigger stays between 50 % and 97 % of the window', () => {
    // A sweep rather than a table: the arithmetic has three regimes (the 40 %
    // cap, the 25 % band and the 97 % ceiling) and the boundaries between them
    // are what a table would silently step over.
    for (let numCtx = 512; numCtx <= 1000000; numCtx += 7919) {
      const trigger = computeCompactionTriggerTokens(numCtx);
      expect(trigger).toBeGreaterThan(numCtx * 0.5);
      expect(trigger).toBeLessThanOrEqual(numCtx * 0.97);
    }
  });

  test('a window that is not a positive finite number has no trigger', () => {
    for (const numCtx of [0, -1, -8192, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeCompactionTriggerTokens(numCtx)).toBe(0);
      expect(computeCompactionReserveTokens(numCtx)).toBe(0);
    }
  });

  test('an 8k window leaves a 2048-token reply', () => {
    // The regression the whole change exists for: the old flat 92 % gate fired
    // at 7360 of 8192 and left 640 tokens — less than one tool call plus its
    // result, so the turn could not finish the request it had just compacted.
    const numCtx = 8192;
    const replyRoom = numCtx - computeCompactionTriggerTokens(numCtx);
    expect(replyRoom).toBeGreaterThanOrEqual(2048);
    expect(replyRoom).toBeGreaterThan(Math.floor(numCtx * 0.08));
  });
});

describe('the compaction size verdict', () => {
  test('a compaction that does not shrink the history is aborted', () => {
    const verdict = evaluateCompactionSizes(7000, 7000, 8192);
    expect(verdict.aborted).toBe(true);
    expect(evaluateCompactionSizes(7000, 7500, 8192).aborted).toBe(true);
    expect(evaluateCompactionSizes(7000, 5000, 8192).aborted).toBe(false);
    // With no OLD count there is nothing to compare against and nothing to abort.
    expect(evaluateCompactionSizes(0, 0, 8192).aborted).toBe(false);
  });

  test('a compaction inside the confirm band is retried after a live check', () => {
    // 7400 of 8192 is 90.3 %: past the 90 % acceptance boundary, but close
    // enough to it that the local estimate could be wrong either way. The OLD
    // count here is 8000, so the compaction did shrink the history — the retry
    // is about what is LEFT, not about whether anything was removed.
    const verdict = evaluateCompactionSizes(8000, 7400, 8192);
    expect(verdict.aborted).toBe(false);
    expect(verdict.retry).toBe(true);
    expect(verdict.confirm).toBe(true);
  });

  test('a compaction far above the boundary is retried without a measurement', () => {
    // 7900 of 8192 is 96.4 %, well outside the ±5 % band: no estimate error can
    // make it acceptable, so paying for a live measurement would buy nothing.
    const verdict = evaluateCompactionSizes(8000, 7900, 8192);
    expect(verdict.retry).toBe(true);
    expect(verdict.confirm).toBe(false);
  });

  test('a compaction just under the boundary is inside the confirm band', () => {
    // 7100 of 8192 is 86.7 %: under the boundary, so no retry — but inside the
    // 85–95 % band, so "accept it" is exactly the decision the estimate cannot
    // be trusted with on its own.
    const verdict = evaluateCompactionSizes(8000, 7100, 8192);
    expect(verdict.retry).toBe(false);
    expect(verdict.confirm).toBe(true);
  });

  test('a compaction well under the boundary is accepted without a measurement', () => {
    const verdict = evaluateCompactionSizes(8000, 5000, 8192);
    expect(verdict.retry).toBe(false);
    expect(verdict.confirm).toBe(false);
  });

  test('refusing a compaction that shrank nothing outranks the retry', () => {
    // 7400 is above the acceptance boundary, so it ALSO looks retryable — but a
    // result that is no smaller than its input is refused outright, because a
    // stronger pass over a history it could not shrink is a wasted model call.
    const verdict = evaluateCompactionSizes(7000, 7400, 8192);
    expect(verdict.aborted).toBe(true);
  });

  test('the retry and confirm boundaries sit exactly at 90 %, 85 % and 95 %', () => {
    // A 10000-token window makes the percentages exact: 9000 / 8500 / 9500.
    const numCtx = 10000;
    expect(evaluateCompactionSizes(numCtx, 9000, numCtx).retry).toBe(false);
    expect(evaluateCompactionSizes(numCtx, 9001, numCtx).retry).toBe(true);
    expect(evaluateCompactionSizes(numCtx, 8500, numCtx).confirm).toBe(true);
    expect(evaluateCompactionSizes(numCtx, 8499, numCtx).confirm).toBe(false);
    expect(evaluateCompactionSizes(numCtx, 9500, numCtx).confirm).toBe(true);
    expect(evaluateCompactionSizes(numCtx, 9501, numCtx).confirm).toBe(false);
  });

  test('a verdict with no usable window never retries or confirms', () => {
    const verdict = evaluateCompactionSizes(7000, 6900, 0);
    expect(verdict).toStrictEqual({ aborted: false, retry: false, confirm: false });
  });
});

describe('the distillation call cap', () => {
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

  test('the distillation cap scales with the window and is clamped', () => {
    for (const [numCtx, expected] of DISTILL_CAP_TABLE) {
      expect(computeDistillCallCap(numCtx)).toBe(expected);
    }
  });

  test('the distillation cap never falls below the floor or above the ceiling', () => {
    for (let numCtx = 512; numCtx <= 1000000; numCtx += 4099) {
      const cap = computeDistillCallCap(numCtx);
      expect(cap >= TOOL_DISTILL_MIN_CALLS && cap <= TOOL_DISTILL_MAX_CALLS).toBeTruthy();
    }
    for (const numCtx of [0, -8192, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeDistillCallCap(numCtx)).toBe(TOOL_DISTILL_MIN_CALLS);
    }
  });
});

describe('the distiller input and digest caps scale with the window', () => {
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

  test('the distiller input cap scales with the window', () => {
    for (const [numCtx, expected] of DISTILL_INPUT_CAP_TABLE) {
      expect(computeDistillInputMaxChars(numCtx)).toBe(expected);
    }
  });

  test('the distiller input cap never exceeds the absolute ceiling', () => {
    // The provider's real input limit may be LOWER than the window Locopilot
    // believes (the OpenAI-compatible adapter never sends `num_ctx`), so a
    // window-derived cap alone can send a request the provider rejects — and a
    // rejected call leaves the tool output VERBATIM, which is what the
    // distillation exists to prevent.
    for (let numCtx = 512; numCtx <= 1048576; numCtx += 997) {
      const cap = computeDistillInputMaxChars(numCtx);
      expect(cap).toBeLessThanOrEqual(TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE);
    }
    expect(TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE).toBe(112000);
    // The ceiling is a QUARTER of a 128k-token provider limit, at the
    // distiller's conservative 3.5 characters per token.
    expect(Math.floor(TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE / DISTILL_CHARS_PER_TOKEN)).toBe(32000);
    expect(32000 * 4).toBeLessThanOrEqual(128000);
  });

  test('the distiller input never exceeds the window it is sent to', () => {
    // The implied token count (characters / 3.5, the CONSERVATIVE conversion)
    // has to leave room for the distiller's OWN answer and the request's own
    // overhead. The old `numCtx * 8` cap allowed 4096 tokens at a 2048-token
    // window: the distillation request itself 400ed and the output stayed
    // verbatim.
    for (let numCtx = 1792; numCtx <= 1048576; numCtx += 1) {
      const implied = computeDistillInputMaxChars(numCtx) / DISTILL_CHARS_PER_TOKEN;
      const limit = numCtx - computeDistillNumPredict(numCtx) - TOOL_DISTILL_INPUT_OVERHEAD_TOKENS;
      if (implied > limit) {
        expect(implied).toBe(limit);
      }
    }
    // Below 1792 tokens the FLOOR of 512 tokens binds, and a window that small
    // cannot host the distiller's own 1024-token answer anyway.
    expect(computeDistillInputMaxChars(1792)).toBe(Math.floor(512 * DISTILL_CHARS_PER_TOKEN));
  });

  test("the distiller's characters-per-token conversion is CONSERVATIVE", () => {
    // The shared 4-characters-per-token estimate is optimistic for exactly the
    // models that need the scaling: Llama and Qwen tokenizers run at roughly
    // 3.0-3.5 characters per token, so a 2 000 000-character output is really
    // 570 000-670 000 tokens — 57-67 % of a 1M window, not 50 %.
    expect(DISTILL_CHARS_PER_TOKEN).toBe(3.5);
    expect(DISTILL_CHARS_PER_TOKEN).toBeLessThan(4);
    // And the cap really is smaller than the optimistic conversion would make
    // it: the same token budget, fewer characters.
    const tokenBudget = 16384;
    expect(computeDistillInputMaxChars(32768)).toBeLessThan(tokenBudget * 4);
    expect(computeDistillInputMaxChars(32768)).toBe(Math.floor(tokenBudget * 3.5));
  });

  test("the distiller's output limit scales with the window", () => {
    for (const [numCtx, expected] of DISTILL_NUM_PREDICT_TABLE) {
      expect(computeDistillNumPredict(numCtx)).toBe(expected);
    }
    // The floor and the ceiling hold at every window.
    for (let numCtx = 512; numCtx <= 1048576; numCtx += 1009) {
      const limit = computeDistillNumPredict(numCtx);
      expect(
        limit >= TOOL_DISTILL_NUM_PREDICT_BASE && limit <= TOOL_DISTILL_NUM_PREDICT_MAX
      ).toBeTruthy();
    }
    // And it never grows by more than one token per 256 tokens of window.
    for (let numCtx = 512; numCtx <= 1048576; numCtx += 1) {
      const limit = computeDistillNumPredict(numCtx);
      expect(limit).toBeLessThanOrEqual(TOOL_DISTILL_NUM_PREDICT_BASE + Math.ceil(numCtx / 256));
    }
  });

  test('the digest cap scales with the window', () => {
    for (const [numCtx, expected] of DISTILL_DIGEST_CAP_TABLE) {
      expect(computeDistillDigestMaxChars(numCtx)).toBe(expected);
    }
  });

  test('the digest cap NEVER cuts the model answer', () => {
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
      expect(cap).toBeGreaterThanOrEqual(capacity);
      expect(cap).toBeLessThanOrEqual(TOOL_DISTILL_DIGEST_MAX_CHARS_CEILING);
    }
    expect(TOOL_DISTILL_DIGEST_MAX_CHARS_CEILING).toBeGreaterThan(
      TOOL_DISTILL_NUM_PREDICT_MAX * DISTILL_OUTPUT_CHARS_PER_TOKEN +
        TOOL_DISTILL_TRUNCATION_MARKER.length
    );
  });

  test.each([512, 1024, 2048, 4096, 8192, 16384, 32768])(
    'the digest cap is never the old flat 2400 characters (%p)',
    (numCtx) => {
      const cap = computeDistillDigestMaxChars(numCtx);
      expect(cap).toBeGreaterThan(2400);
    }
  );

  test('which of the two bounds the digest cap is, at each window', () => {
    for (const [numCtx, expected] of DISTILL_DIGEST_BINDING_TABLE) {
      const capacity =
        computeDistillNumPredict(numCtx) * DISTILL_OUTPUT_CHARS_PER_TOKEN +
        TOOL_DISTILL_TRUNCATION_MARKER.length;
      const share = Math.floor(numCtx * TOOL_DISTILL_MAX_CHARS_WINDOW_RATIO);
      const binding = share > capacity ? 'window' : 'output';
      expect(binding).toBe(expected);
      // The cap is the LARGER of the two — the point of the whole fix.
      expect(computeDistillDigestMaxChars(numCtx)).toBe(Math.max(capacity, share));
    }
  });
});

describe('the distiller tells the truth about what it cut', () => {
  test('a truncated input says how much of it was sent, and fits in the cap', () => {
    const content = 'x'.repeat(5000);
    const cap = 1000;
    const result = truncateToolOutputForDistillation(content, cap);
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(5000);
    expect(result.keptChars).toBeGreaterThan(0);
    expect(result.keptChars).toBeLessThan(cap);
    // The marker counts towards the cap: the result never exceeds it.
    expect(result.text.length).toBeLessThanOrEqual(cap);
    // The kept count is the SLICE, not the raw length.
    expect(result.text.slice(0, result.keptChars)).toBe('x'.repeat(result.keptChars));
    expect(result.text).toContain(`only the first ${result.keptChars} of 5000 characters`);
    expect(result.text).toContain(
      `the remaining ${5000 - result.keptChars} characters were NOT included`
    );
    expect(result.text).toMatch(
      /\[\.\.\.truncated: only the first \d+ of 5000 characters of this tool output were sent to the distiller; the remaining \d+ characters were NOT included]$/
    );
  });

  test('an output that fits is sent whole and unmarked', () => {
    const result = truncateToolOutputForDistillation('abc', 1000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('abc');
    expect(result.keptChars).toBe(3);
    expect(result.totalChars).toBe(3);
  });

  test('a zero-length output is skipped, not marked', () => {
    const result = truncateToolOutputForDistillation('', 1000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('');
    expect(result.keptChars).toBe(0);
    expect(result.totalChars).toBe(0);
  });
});

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

describe('the distillation planner spends calls on the biggest results', () => {
  test('the three largest eligible outputs are selected, in ascending index order', () => {
    // Unequal sizes on purpose: a positional policy would spend its calls on the
    // first three, which are the smallest ones here.
    const sizes = [1300, 5000, 2000, 40000, 1500, 8000, 3000, 1600, 12000, 6000];
    const history = distillFixture(sizes);
    const plan = planDistillation(history, 3);
    expect(plan.selected).toStrictEqual([toolIndex(3), toolIndex(5), toolIndex(8)]);
    expect(plan.skipped).toBe(sizes.length - 3);
    // Ascending, so the caller can rebuild the history in one pass.
    expect([...plan.selected].sort((left, right) => left - right)).toStrictEqual(plan.selected);
  });

  test('equal sizes are broken by position, lowest index first', () => {
    const history = distillFixture([4000, 2000, 4000]);
    const plan = planDistillation(history, 1);
    expect(plan.selected).toStrictEqual([toolIndex(0)]);
  });

  test('a tool row with no matching assistant is neither selected nor counted', () => {
    const [assistantA, toolA] = distillPair(9000, 'call-a');
    const [, toolB] = distillPair(20000, 'call-b');
    const orphan = { role: 'tool', content: 'x'.repeat(30000), tool_call_id: 'call-missing' };
    const history = [assistantA, toolA, orphan, toolB];
    const plan = planDistillation(history, 1);
    // The orphan is the biggest row in the slice, and it is still not selected:
    // distillation would have no owning call to name, and its digest would be an
    // orphan tool row afterwards.
    expect(plan.selected).toStrictEqual([toolIndex(0)]);
    expect(plan.skipped).toBe(0);
  });

  test('a row below the character threshold is not a candidate', () => {
    const history = distillFixture([TOOL_DISTILL_CHAR_THRESHOLD - 1, TOOL_DISTILL_CHAR_THRESHOLD]);
    const plan = planDistillation(history, 8);
    expect(plan.selected).toStrictEqual([toolIndex(1)]);
    expect(plan.skipped).toBe(0);
  });

  test('a cap of zero selects nothing and reports every candidate as skipped', () => {
    const history = distillFixture([2000, 3000, 4000]);
    const plan = planDistillation(history, 0);
    expect(plan.selected).toStrictEqual([]);
    expect(plan.skipped).toBe(3);
  });

  test('a cap larger than the candidate list selects everything', () => {
    const history = distillFixture([2000, 3000]);
    const plan = planDistillation(history, TOOL_DISTILL_MAX_CALLS);
    expect(plan.selected).toStrictEqual([toolIndex(0), toolIndex(1)]);
    expect(plan.skipped).toBe(0);
  });

  test('an oversized tool row with no owning assistant is counted apart from the cap', () => {
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
    expect(plan.skipped).toBe(1);
    expect(plan.orphans).toBe(1);
  });
});

describe('the extra distillation spend plans the leftovers', () => {
  // The EXTRA spend: the SECOND pass over the preserved window, made when the
  // window trim has proved not to be enough. It may only digest the rows the
  // FIRST pass never touched — the ones the call cap (or the prefill budget)
  // left behind.
  //
  // WHY the plan is a separate concern: the call cap saturates at 8 calls, but
  // the prefill budget is ONE WINDOW. At a 1M-token window the cap binds
  // FIRST, so ~790 000 tokens of the budget go UNSPENT while the oversized
  // outputs that were not digested stay VERBATIM in the preserved window — and
  // a verbatim tool output in the result is exactly what makes it too big.

  /**
   * Plans one distillation pass with the caps the orchestrator uses.
   *
   * @param {object[]} history - the slice to plan over.
   * @param {number} maxCalls - the call ceiling.
   * @param {number} budgetTokens - the prefill tokens the pass may spend.
   * @param {number} [perCallMaxChars] - the per-call input cap.
   * @param {Set<number>} [excludeIndices] - the rows an earlier pass dealt with.
   * @returns {object} the plan.
   */
  function passPlan(history, maxCalls, budgetTokens, perCallMaxChars = 100_000, excludeIndices) {
    return planDistillPass({
      historyMessages: history,
      maxCalls,
      perCallMaxChars,
      budgetTokens,
      ...(excludeIndices === undefined ? {} : { excludeIndices }),
    });
  }

  test('the extra pass takes the NEXT largest outputs, never a digest again', () => {
    const sizes = [1300, 5000, 2000, 40000, 1500, 8000, 3000, 1600, 12000, 6000];
    const history = distillFixture(sizes);

    // The FIRST pass: the three largest, exactly as the ordering check above
    // pins.
    const first = passPlan(history, 3, 1_000_000);
    expect(first.calls.map((call) => call.index)).toStrictEqual([
      toolIndex(3),
      toolIndex(5),
      toolIndex(8),
    ]);

    // The SECOND pass: the SAME planner, over the rows the first pass did not
    // digest. It takes the next three largest — and never one of the three the
    // first pass already turned into a digest (a digest can be LONGER than the
    // output it replaced, so distilling it again would make the window bigger).
    const digested = new Set(first.calls.map((call) => call.index));
    const second = passPlan(history, 3, 1_000_000, 100_000, digested);
    expect(second.calls.map((call) => call.index)).toStrictEqual([
      toolIndex(1),
      toolIndex(6),
      toolIndex(9),
    ]);
    for (const call of second.calls) {
      expect(digested.has(call.index)).toBeFalsy();
    }
    // The two passes together covered six DISTINCT rows.
    const covered = new Set([...first.calls, ...second.calls].map((call) => call.index));
    expect(covered.size).toBe(6);
  });

  test('an excluded row is neither selected nor counted as left behind', () => {
    const history = distillFixture([4000, 2000, 3000]);
    const excluded = new Set([toolIndex(0)]);
    const plan = planDistillation(history, 8, undefined, excluded);
    expect(plan.selected).toStrictEqual([toolIndex(1), toolIndex(2)]);
    // The cap did not leave the excluded row behind — an earlier pass dealt
    // with it — so it must not be reported as a candidate the cap skipped.
    expect(plan.skipped).toBe(0);
  });

  test('the extra spend is bounded by the call ceiling', () => {
    const history = distillFixture(Array.from({ length: 40 }, () => 5000));
    const plan = passPlan(history, TOOL_DISTILL_EXTRA_CALLS_MAX, 10_000_000);
    expect(plan.calls).toHaveLength(TOOL_DISTILL_EXTRA_CALLS_MAX);
    expect(plan.capSkipped).toBe(40 - TOOL_DISTILL_EXTRA_CALLS_MAX);
  });

  test('the extra spend never exceeds the leftover budget', () => {
    const sizes = [900_000, 800_000, 700_000, 600_000, 500_000, 400_000];
    const history = distillFixture(sizes);
    const leftover = 100_000;
    const plan = passPlan(history, TOOL_DISTILL_EXTRA_CALLS_MAX, leftover, 112_000);
    expect(plan.prefillTokens).toBeLessThanOrEqual(leftover);
    for (const call of plan.calls) {
      expect(call.prefillTokens).toBeLessThanOrEqual(leftover);
    }
    // And a candidate the budget cannot pay for is SKIPPED, not allowed to
    // overshoot — the same rule the first pass obeys.
    expect(plan.budgetSkipped).toBeGreaterThan(0);
  });

  test('the leftover budget of a 1M window is worth dozens of extra digests', () => {
    // THE SCENARIO THE FEATURE EXISTS FOR. At a 1M-token window the call cap
    // (8) binds BEFORE the prefill budget (one window): eight calls at the
    // per-call ceiling cost ~258 000 tokens, so ~790 000 tokens of the budget
    // go UNSPENT — and the oversized outputs that were not digested stay
    // VERBATIM in the preserved window, which is what makes the result too
    // big.
    const numCtx = 1048576;
    const perCall = computeDistillInputMaxChars(numCtx);
    const budget = createDistillBudget(numCtx);
    const history = distillFixture(Array.from({ length: 34 }, () => 200_000));

    const first = passPlan(history, computeDistillCallCap(numCtx), budget.totalTokens, perCall);
    expect(first.calls).toHaveLength(8);
    expect(first.prefillTokens).toBeLessThan(budget.totalTokens / 2);

    const leftover = budget.totalTokens - first.prefillTokens;
    const extra = passPlan(
      history,
      TOOL_DISTILL_EXTRA_CALLS_MAX,
      leftover,
      perCall,
      new Set(first.calls.map((call) => call.index))
    );
    expect(extra.calls.length).toBeGreaterThan(8);
    expect(extra.prefillTokens).toBeLessThanOrEqual(leftover);
    // And it is the BUDGET, not the ceiling, that bounds the extra spend at
    // this window: the leftover cannot pay for 32 calls.
    expect(extra.calls.length).toBeLessThan(TOOL_DISTILL_EXTRA_CALLS_MAX);
    // The rows the first pass digested are never digested again.
    const digested = new Set(first.calls.map((call) => call.index));
    for (const call of extra.calls) {
      expect(digested.has(call.index)).toBeFalsy();
    }
  });

  test('the extra spend never re-tries a row whose call failed', async () => {
    // A failed call leaves the output VERBATIM — so it IS un-digested — but it
    // is not retried here: the provider that just refused the request will
    // refuse it again, and the extra spend may make up to 32 calls.
    const history = distillFailureFixture();
    const first = await distillToolMessages(
      REFUSING_CTX,
      history,
      8192,
      MODEL,
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(first.failedCount).toBe(2);
    expect(first.failedIndices).toStrictEqual([1, 4]);
    expect(first.distilledIndices).toStrictEqual([]);
    // The extra pass excludes both the digests and the failures: there is
    // nothing left for it to digest.
    const handled = new Set([...first.distilledIndices, ...first.failedIndices]);
    const extra = passPlan(history, 8, 1_000_000, 100_000, handled);
    expect(extra.calls).toHaveLength(0);
    expect(extra.candidateCount).toBe(0);
  });
});

describe('the distillation prefill budget bounds the whole compaction', () => {
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

  test('the prefill budget is one window of tokens', () => {
    for (const [numCtx, expected] of DISTILL_PREFILL_BUDGET_TABLE) {
      expect(computeDistillPrefillBudgetTokens(numCtx)).toBe(expected);
    }
    expect(TOOL_DISTILL_PREFILL_BUDGET_WINDOW_RATIO).toBe(1);
    // A window that is not known still gets a usable budget — a budget of zero
    // would silently disable the distillation for every such caller.
    for (const numCtx of [0, -8192, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeDistillPrefillBudgetTokens(numCtx)).toBeGreaterThan(0);
    }
  });

  test('a plan over many oversized results never exceeds the budget', () => {
    // The regression the budget exists for: the per-call input grew 40x, so
    // eight calls at half a million tokens each is ~4M tokens of prefill
    // inside ONE compaction — several times the window it is trying to shrink.
    const sizes = [900_000, 800_000, 700_000, 600_000, 500_000, 400_000, 300_000, 200_000, 100_000];
    const history = distillFixture(sizes);
    const plan = planDistillation(history, TOOL_DISTILL_MAX_CALLS);
    expect(plan.selected).toHaveLength(TOOL_DISTILL_MAX_CALLS);

    for (const numCtx of [8192, 32768, 131072, 262144, 1048576]) {
      const budget = createDistillBudget(numCtx);
      const calls = planDistillCalls(
        history,
        plan.selected,
        computeDistillInputMaxChars(numCtx),
        budget.totalTokens - budget.usedTokens
      );
      expect(calls.prefillTokens).toBeLessThanOrEqual(budget.totalTokens);
      // And every call is affordable on its own.
      for (const call of calls.calls) {
        expect(call.prefillTokens).toBeLessThanOrEqual(budget.totalTokens);
      }
    }
  });

  test('the budget is spent on the LARGEST results first', () => {
    // The biggest outputs are the ones that decide whether the compacted
    // history fits, and they are the most expensive to distil — so they are
    // the ones worth the budget.
    const sizes = [900_000, 800_000, 700_000, 600_000];
    const history = distillFixture(sizes);
    const plan = planDistillation(history, TOOL_DISTILL_MAX_CALLS);
    const perCall = computeDistillInputMaxChars(131072);
    const calls = planDistillCalls(history, plan.selected, perCall, 40_000);
    expect(calls.calls.length).toBeGreaterThan(0);
    expect(calls.calls.length).toBeLessThan(plan.selected.length);
    // The first call (largest first) is the biggest output, and the ones that
    // were dropped are the SMALLER ones.
    expect(calls.calls[0].index).toBe(toolIndex(0));
    expect(calls.budgetSkipped).toBeGreaterThan(0);
    const dropped = plan.selected.filter(
      (index) => !calls.calls.some((call) => call.index === index)
    );
    for (const index of dropped) {
      expect(index).toBeGreaterThan(calls.calls.at(-1).index);
    }
  });

  test('the progress data is derivable from the plan', () => {
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
    expect(candidates).toBe(sizes.length);
    expect(calls.calls.length).toBeLessThanOrEqual(plan.selected.length);
    expect(calls.budgetSkipped).toBe(plan.selected.length - calls.calls.length);
    expect(calls.prefillTokens).toBe(
      calls.calls.reduce((total, call) => total + call.prefillTokens, 0)
    );
    // The budget is spent, not exceeded: what is left is never negative.
    expect(budget.totalTokens - calls.prefillTokens).toBeGreaterThanOrEqual(0);
  });

  test('the prefill estimate is conservative', () => {
    expect(estimateDistillPrefillTokens(0)).toBe(0);
    expect(estimateDistillPrefillTokens(-10)).toBe(0);
    expect(estimateDistillPrefillTokens(3500)).toBe(1000);
    // It never UNDER-counts: 3.5 characters per token is the conservative side.
    expect(estimateDistillPrefillTokens(112000)).toBeGreaterThanOrEqual(32000);
    expect(estimateDistillPrefillTokens(112000)).toBe(32000);
  });
});

describe('the distillation call has a timeout', () => {
  test('the timeout scales with the request and is bounded', () => {
    // The request used to carry NO timeout, so a slow prefill could hang the
    // compaction for ever.
    const small = computeDistillTimeoutMs(768, 1024);
    const large = computeDistillTimeoutMs(32_000, 4096);
    expect(small).toBeLessThan(large);
    expect(small).toBeGreaterThanOrEqual(TOOL_DISTILL_TIMEOUT_BASE_MS);
    expect(large).toBeLessThanOrEqual(TOOL_DISTILL_TIMEOUT_MAX_MS);
    // And it never leaves the band, whatever it is asked.
    for (let tokens = 0; tokens <= 200_000; tokens += 997) {
      for (const output of [1024, 2048, 4096]) {
        const timeout = computeDistillTimeoutMs(tokens, output);
        expect(
          timeout >= TOOL_DISTILL_TIMEOUT_BASE_MS && timeout <= TOOL_DISTILL_TIMEOUT_MAX_MS
        ).toBeTruthy();
      }
    }
  });

  test('the timeout is never shorter than the base and never longer than the ceiling', () => {
    expect(computeDistillTimeoutMs(0, 0)).toBe(TOOL_DISTILL_TIMEOUT_BASE_MS + 0);
    expect(computeDistillTimeoutMs(0, 1024)).toBe(TOOL_DISTILL_TIMEOUT_BASE_MS + 60_000);
    expect(computeDistillTimeoutMs(1_000, 1024)).toBe(
      TOOL_DISTILL_TIMEOUT_BASE_MS + 20_000 + 60_000
    );
    expect(computeDistillTimeoutMs(1_000_000, 4096)).toBe(TOOL_DISTILL_TIMEOUT_MAX_MS);
  });
});

describe('a failed distillation does not cost the whole compaction', () => {
  /**
   * An LLM context whose calls fail at the TRANSPORT layer (port 1 refuses the
   * connection immediately) — no network, no quota, no model.
   */

  test('a failing distillation call keeps its message verbatim, and the pass goes on', async () => {
    const history = distillFailureFixture();
    const progress = [];
    const result = await distillToolMessages(REFUSING_CTX, history, 8192, MODEL, 2, (message) =>
      progress.push(message)
    );
    // Two candidates, two failed calls: the loop did not stop after the first
    // throw, and nothing was replaced.
    expect(result.failedCount).toBe(2);
    expect(result.distilledCount).toBe(0);
    expect(result.messages.map((entry) => entry.content)).toStrictEqual(
      history.map((entry) => entry.content)
    );
    expect(result.messages.length).toBe(history.length);
    // Not silent: one line names how many calls failed AND why, because a
    // failed call leaves the tool output VERBATIM — the thing the
    // distillation existed to prevent.
    const reported = progress.filter((line) => /tool distillation call\(s\) failed/.test(line));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/2 of 2 tool distillation call\(s\) failed/);
    expect(reported[0]).toMatch(/stay verbatim/);
    expect(reported[0]).toMatch(/\(.+\)/);
    // And the pass reports what it did as well as what it could not do.
    expect(result.attemptedCount).toBe(2);
    expect(result.candidateCount).toBe(2);
    expect(result.prefillTokens).toBeGreaterThan(0);
  });

  test('an abort still propagates out of the distiller', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      distillToolMessages(
        REFUSING_CTX,
        distillFailureFixture(),
        8192,
        MODEL,
        2,
        undefined,
        controller.signal
      )
    ).rejects.toThrow();
  });

  test('the budget stops the calls it cannot pay for', async () => {
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
    expect(result.distilledCount).toBe(0);
    expect(result.attemptedCount).toBe(0);
    expect(result.budgetSkippedCount).toBe(2);
    expect(result.prefillTokens).toBe(0);
    expect(result.messages.map((entry) => entry.content)).toStrictEqual(
      history.map((entry) => entry.content)
    );
    expect(progress.some((line) => /prefill budget ran out/.test(line))).toBeTruthy();
  });
});

describe('the retry pass knows the system prompt', () => {
  test('compactHistory takes the system-prompt tokens and forwards them', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/services/compact/orchestrate.ts', import.meta.url)),
      'utf8'
    );
    // The parameter exists because the retry recursion deliberately passes a
    // history WITHOUT the system row, so the inner pass would compute 0.
    expect(source).toContain('systemPromptTokens?: number');
    expect(source).toContain('systemPromptTokens ?? countMessagesTokens(systemMessages, model)');
    const retryIndex = source.indexOf('const retryResult = await compactHistory(');
    expect(retryIndex).not.toBe(-1);
    const retryCall = source.slice(retryIndex, source.indexOf('\n    );', retryIndex));
    expect(retryCall).toMatch(/focus,[\S\s]*\bresolvedSystemPromptTokens\b/);
    // And the NEW count (the one the acceptance decision and the stats use) is
    // the local count plus that number.
    expect(source).toContain(
      'countMessagesTokens(newMessages, model) + resolvedSystemPromptTokens'
    );
  });
});

describe('the reasoning effort forwarded to the summariser', () => {
  test("the UI default 'off' is never forwarded", () => {
    expect(forwardableReasoningEffort(undefined)).toBeUndefined();
    expect(forwardableReasoningEffort('off')).toBeUndefined();
    expect(forwardableReasoningEffort('high')).toBe('high');
    expect(forwardableReasoningEffort('none')).toBe('none');
    expect(forwardableReasoningEffort('max')).toBe('max');
  });
});

describe('the retired 92 % gate and the measurement cost', () => {
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

  test('no source file still names the retired flat 92 % gate', () => {
    const offenders = listSourceFiles(path.join(REPO_ROOT, 'src')).filter((file) =>
      readFileSync(file, 'utf8').includes('AUTO_COMPACT_THRESHOLD_PCT')
    );
    expect(offenders.map((file) => file.slice(REPO_ROOT.length))).toStrictEqual([]);
  });

  test('the pipeline measures a conversation once, and only to confirm', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'),
      'utf8'
    );
    const calls = source.match(/measureConversationTokens\(/g) ?? [];
    // The import statement carries no parenthesis, so only real CALLS match.
    expect(calls).toHaveLength(1);
    const confirmIndex = source.indexOf('if (verdict.confirm)');
    expect(confirmIndex).not.toBe(-1);
    expect(source.indexOf('measureConversationTokens(')).toBeGreaterThan(confirmIndex);
    // Both sizes come from the free local tokenizer.
    const localCounts = source.match(/countMessagesTokens\(/g) ?? [];
    expect(localCounts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the recent-files stub budget', () => {
  test.each(CONTEXT_SIZES)(
    'the stub budget never exceeds the window share or the flat cap (%p)',
    (numCtx) => {
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
        expect(budget).toBeLessThanOrEqual(ceiling);
      }
    }
  );

  test.each([1024, 2048, 4096, 8192, 32768, 131072])(
    'the stub budget can never make the result no smaller than its input (%p)',
    (numCtx) => {
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
          expect(Number.isInteger(budget) && budget >= RECENT_FILES_MIN_TOKENS).toBeTruthy();
          // Everything the result would carry if the stub spent its whole budget:
          // the charges, the 8-token framing, and the budget itself. It has to
          // stay strictly under the OLD size or the abort guard fires.
          const worstCase = headerTokens + windowTokens + systemPromptTokens + 8 + budget;
          expect(worstCase).toBeLessThan(old);
          expect(worstCase).toBeLessThanOrEqual(acceptanceBudget);
        }
      }
    }
  );

  test('the stub budget is zero when the existing charges already exceed it', () => {
    const acceptanceBudget = Math.floor(8192 * 0.9);
    for (const charges of [
      { headerTokens: 4000, windowTokens: 5000, systemPromptTokens: 2000 },
      { headerTokens: acceptanceBudget, windowTokens: 0, systemPromptTokens: 0 },
      { headerTokens: 0, windowTokens: 0, systemPromptTokens: acceptanceBudget + 1 },
      // The history was already tighter than the acceptance boundary.
      { headerTokens: 100, windowTokens: 100, systemPromptTokens: 100 },
    ]) {
      const oldTokenCount = charges.headerTokens === 100 ? 400 : 1_000_000;
      expect(
        computeRecentFilesBudget({ numCtx: 8192, acceptanceBudget, oldTokenCount, ...charges })
      ).toBe(0);
    }
  });

  test('the ceiling bounds the MESSAGE, framing included', () => {
    // The budget is a budget for the stub's TEXT, and the message that carries it
    // costs 5 tokens more (a message base plus the role name). The ceiling used to
    // be applied to the text alone, so a stub at its full budget overran by the
    // framing — measured at 2 tokens on a real plan, 5 in the worst case.
    const framing =
      countMessageTokens({ role: 'assistant', content: 'a' }, MODEL) - countTextTokens('a', MODEL);
    expect(framing).toBe(RECENT_FILES_MESSAGE_FRAMING_TOKENS);

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
          expect(budget + framing).toBeLessThanOrEqual(ceiling);
          // The saving bound is now stricter by the same amount, because the
          // framing has to fit inside it too.
          const worstCase =
            headerTokens +
            windowTokens +
            systemPromptTokens +
            RECENT_FILES_MESSAGE_OVERHEAD_TOKENS +
            budget +
            framing;
          expect(worstCase < old || old === 0).toBeTruthy();
          expect(worstCase).toBeLessThanOrEqual(acceptanceBudget);
        }
      }
    }
  });

  test('the floor is above the cheapest stub that is worth emitting', () => {
    // 150 used to be the floor, and the cheapest mandatory stub (header + five
    // path-only bullets + end marker) measured 176 — so the band 150–176 bought
    // nothing while the comment claimed it did. The floor now covers the
    // measured cost of five path-only bullets at ~80-character paths (~280
    // tokens), and `test-compact-recent-files` proves a budget of exactly the
    // floor really buys that stub.
    expect(RECENT_FILES_MIN_TOKENS).toBeGreaterThanOrEqual(280);
  });
});
