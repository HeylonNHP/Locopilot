/**
 * budget.ts
 *
 * Pure token-budget maths for the compaction pipeline. All sizing decisions —
 * safe input budgets, per-request summary targets, and chunk boundaries — are
 * computed here so the orchestration logic stays free of magic numbers.
 */

import type { SummaryBudget } from './types';

import {
  COMPACT_ACCEPTANCE_HEADROOM,
  COMPACT_MEASURE_CONFIRM_BAND_RATIO,
  COMPACT_REPLY_RESERVE_BASE_WINDOW,
  COMPACT_REPLY_RESERVE_GROWTH,
  COMPACT_REPLY_RESERVE_TOKENS,
  COMPACT_RESERVE_MAX_TOKENS,
  COMPACT_RESERVE_MAX_WINDOW_RATIO,
  COMPACT_RESERVE_MIN_TOKENS,
  COMPACT_RESERVE_RATIO,
  COMPACT_TRIGGER_MAX_WINDOW_RATIO,
  MAX_SUMMARY_TOKENS_CEILING,
  MAX_SUMMARY_TOKENS_CEILING_RATIO,
  MAX_SUMMARY_TOKENS_FLOOR,
  MAX_SUMMARY_TOKENS_FLOOR_RATIO,
  MAX_TARGET_TOKENS_FLOOR,
  MIN_SUMMARY_TOKENS_RATIO,
  MIN_TARGET_TOKENS_RATIO,
  SAFE_INPUT_BUDGET_RATIO,
  SOURCE_CAP_RATIO,
  SUMMARY_MAX_TOKENS_RATIO,
  SUMMARY_NUM_PREDICT_BUFFER_RATIO,
  SUMMARY_TARGET_TOKENS_RATIO,
  TOOL_DISTILL_CALLS_PER_WINDOW,
  TOOL_DISTILL_DIGEST_MAX_CHARS_CEILING,
  TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE,
  TOOL_DISTILL_INPUT_MIN_TOKENS,
  TOOL_DISTILL_INPUT_OVERHEAD_TOKENS,
  TOOL_DISTILL_INPUT_TOKEN_RATIO,
  TOOL_DISTILL_MAX_CALLS,
  TOOL_DISTILL_MAX_CHARS_WINDOW_RATIO,
  TOOL_DISTILL_MIN_CALLS,
  TOOL_DISTILL_NUM_PREDICT_BASE,
  TOOL_DISTILL_NUM_PREDICT_MAX,
  TOOL_DISTILL_NUM_PREDICT_WINDOW_DIVISOR,
  TOOL_DISTILL_PREFILL_BUDGET_DEFAULT_TOKENS,
  TOOL_DISTILL_PREFILL_BUDGET_WINDOW_RATIO,
  TOOL_DISTILL_TIMEOUT_BASE_MS,
  TOOL_DISTILL_TIMEOUT_MAX_MS,
  TOOL_DISTILL_TIMEOUT_MS_PER_1K_OUTPUT_TOKENS,
  TOOL_DISTILL_TIMEOUT_MS_PER_1K_PREFILL_TOKENS,
  TOOL_DISTILL_TRUNCATION_MARKER,
} from './constants';

/**
 * The characters-per-token conversion the distiller's caps use.
 *
 * WHY it is CONSERVATIVE (3.5) and not the app-wide 4: the shared
 * {@link APPROX_CHARS_PER_TOKEN} is optimistic for exactly the models that
 * need the distiller to scale. Llama and Qwen tokenizers run at roughly
 * 3.0-3.5 characters per token, so a 2 000 000-character tool output is
 * really 570 000-670 000 tokens, not 500 000 — 57-67 % of a 1M-token window
 * instead of 50 %. A cap that assumes 4 characters per token therefore
 * OVERSHOOTS the window by a third, and the request that overshoots is the
 * request the provider rejects.
 *
 * WHY it lives here and not in `constants.ts`: it is a property of the
 * DISTILLATION budget, not a global truth about tokenizers. The shared
 * constant is used for the app's other estimates and is deliberately left
 * alone.
 */
export const DISTILL_CHARS_PER_TOKEN = 3.5;

/**
 * The characters-per-token conversion for the distiller's OUTPUT.
 *
 * WHY it is GENEROUS (5) and the opposite of {@link DISTILL_CHARS_PER_TOKEN}:
 * the two conversions are used in opposite directions. The input conversion
 * turns characters into tokens, where an over-estimate is SAFE (it sends
 * less than the window allows). The output conversion turns the model's
 * token allowance into the characters the digest cap has to allow, where an
 * under-estimate CUTS THE MODEL'S ANSWER — the exact defect this budget
 * exists to remove. A token carries about 3.5-4 characters of English or
 * code; 5 leaves room for the long ones (indentation runs, JSON blobs).
 */
export const DISTILL_OUTPUT_CHARS_PER_TOKEN = 5;

export function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

/**
 * The token margin auto-compaction RESERVES for the reply and for the next
 * request, given the model's context window.
 *
 * The reserve is the REPLY BUDGET: the room the model needs to finish its
 * answer after compaction has fired. It is 25 % of the window, floored at
 * {@link COMPACT_RESERVE_MIN_TOKENS} (a tiny local model must not give up a
 * whole prompt's worth of history) and CEILINGED at the larger of
 * {@link COMPACT_RESERVE_MAX_TOKENS} and the √ reply budget
 * ({@link COMPACT_REPLY_RESERVE_TOKENS} at
 * {@link COMPACT_REPLY_RESERVE_BASE_WINDOW}, growing with
 * {@link COMPACT_REPLY_RESERVE_GROWTH}).
 *
 * WHY the ceiling has to grow: the old flat 13 000-token ceiling made the
 * reserve 1.2 % of a 1M-token window, so compaction fired at 97 % of the
 * window and a long reply overflowed mid-generation — the turn died with the
 * answer half-written. The reply budget is not the window: a bigger window
 * makes the QUESTION bigger, not the ANSWER, so the reserve grows with the
 * square root of the window (8192 at 32k → 16 384 at 128k → 23 170 at 256k →
 * 46 340 at 1M) instead of with the window.
 *
 * WHY √ and not linear: a linear reserve would take a quarter of a 1M window
 * away from the history to pay for an answer that is not 32× longer.
 *
 * WHY every window at or below ~82 500 is untouched: the √ ceiling is below
 * the old flat 13 000-token ceiling for every window up to 82 532 tokens, so
 * the tuned 8k/32k cases (and every smaller one) compute exactly what they
 * computed before.
 *
 * The result is finally capped at 40 % of the window (see
 * {@link COMPACT_RESERVE_MAX_WINDOW_RATIO}), because on a 2048-token window
 * the clamp alone would reserve 27 % and compaction would fire constantly.
 */
export function computeCompactionReserveTokens(numCtx: number): number {
  if (!Number.isFinite(numCtx) || numCtx <= 0) {
    return 0;
  }
  const ceiling = Math.max(
    COMPACT_RESERVE_MAX_TOKENS,
    Math.floor(
      COMPACT_REPLY_RESERVE_TOKENS *
        (numCtx / COMPACT_REPLY_RESERVE_BASE_WINDOW) ** COMPACT_REPLY_RESERVE_GROWTH
    )
  );
  const reserve = clamp(
    Math.floor(numCtx * COMPACT_RESERVE_RATIO),
    COMPACT_RESERVE_MIN_TOKENS,
    ceiling
  );
  return Math.min(reserve, Math.floor(numCtx * COMPACT_RESERVE_MAX_WINDOW_RATIO));
}

/**
 * The token count at which auto-compaction fires: the window minus the
 * reserved margin, and never later than 97 % of the window.
 *
 * WHY the reserve rather than a percentage of the window: the reply (and the
 * next request) has to fit in what is left AFTER the trigger, so the gate has
 * to be expressed as "the room the model still needs", not as "how full the
 * window looks". A flat 92 % gate left 640 tokens on an 8k window — less than
 * the model needs to answer — which is what this function replaces.
 *
 * Returns 0 for a non-finite or non-positive window: a caller that does not
 * know its window cannot have a meaningful trigger (`Infinity - reserve` would
 * otherwise be a trigger that never fires).
 */
export function computeCompactionTriggerTokens(numCtx: number): number {
  if (!Number.isFinite(numCtx) || numCtx <= 0) {
    return 0;
  }
  const reserve = computeCompactionReserveTokens(numCtx);
  return Math.min(numCtx - reserve, Math.floor(numCtx * COMPACT_TRIGGER_MAX_WINDOW_RATIO));
}

/** What the pipeline should do with a freshly compacted history. */
export interface CompactionSizeVerdict {
  /** The compaction did not shrink the history at all — refuse it. */
  aborted: boolean;
  /** Still above the acceptance boundary — retry with stronger compression. */
  retry: boolean;
  /** Close enough to the boundary that the estimate needs a live check. */
  confirm: boolean;
}

/**
 * Decides what to do with a compacted history from its OLD and NEW token
 * counts, without paying for a measurement.
 *
 * `confirm` is symmetric around the acceptance boundary on purpose: an
 * estimate that lands inside the band could be wrong in EITHER direction, so
 * both "looks retryable" and "looks acceptable" have to be confirmed before
 * the (expensive, recursive) retry decision is taken for good.
 */
export function evaluateCompactionSizes(
  oldTokens: number,
  newTokens: number,
  numCtx: number
): CompactionSizeVerdict {
  const hasWindow = Number.isFinite(numCtx) && numCtx > 0;
  const acceptanceBudget = Math.floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM);
  const band = Math.floor(numCtx * COMPACT_MEASURE_CONFIRM_BAND_RATIO);
  return {
    aborted: oldTokens > 0 && newTokens >= oldTokens,
    retry: hasWindow && newTokens > acceptanceBudget,
    confirm: hasWindow && Math.abs(newTokens - acceptanceBudget) <= band,
  };
}

/**
 * How many tool-output distillation calls one compaction may spend on a given
 * context window: one per 16k of window, clamped to `[2, 8]`.
 *
 * A window that is not a positive finite number gets the MINIMUM, not zero:
 * the caller reached this point with a history it is trying to shrink, and a
 * cap of zero would silently disable distillation entirely for every caller
 * that forgot to thread its window through.
 *
 * 2048 → 2, 8192 → 2, 32768 → 2, 65536 → 4, 131072 → 8.
 */
export function computeDistillCallCap(numCtx: number): number {
  if (!Number.isFinite(numCtx) || numCtx <= 0) {
    return TOOL_DISTILL_MIN_CALLS;
  }
  return clamp(
    Math.ceil(numCtx * TOOL_DISTILL_CALLS_PER_WINDOW),
    TOOL_DISTILL_MIN_CALLS,
    TOOL_DISTILL_MAX_CALLS
  );
}

/**
 * The number of tokens the distiller may emit for a given context window.
 *
 * WHY the output limit scales with the window: the digest IS the model's
 * answer, so the size of the digest is set by what the model can emit. With
 * a flat 1024-token limit a 1M-token window still got a ~4096-character
 * digest and the "the digest scales with the window" claim was false.
 *
 * `clamp(floor(numCtx / 256), 1024, 4096)`: 1024 tokens at every window up
 * to 262 144, 2048 at 524 288, 4096 at 1 048 576.
 *
 * WHY a window that is not a positive finite number gets the BASE: the
 * caller reached this point with a history it is trying to shrink, and a
 * limit of zero would make the distillation request ask for nothing.
 */
export function computeDistillNumPredict(numCtx: number): number {
  if (!Number.isFinite(numCtx) || numCtx <= 0) {
    return TOOL_DISTILL_NUM_PREDICT_BASE;
  }
  return clamp(
    Math.floor(numCtx / TOOL_DISTILL_NUM_PREDICT_WINDOW_DIVISOR),
    TOOL_DISTILL_NUM_PREDICT_BASE,
    TOOL_DISTILL_NUM_PREDICT_MAX
  );
}

/**
 * The largest TOOL OUTPUT the distiller may be sent, in characters.
 *
 * The budget is a TOKEN budget first: the tool output may take
 * {@link TOOL_DISTILL_INPUT_TOKEN_RATIO} of the window, but never more than
 * the window minus the distiller's own answer
 * ({@link computeDistillNumPredict}) and the request's overhead
 * ({@link TOOL_DISTILL_INPUT_OVERHEAD_TOKENS}) — a distillation request that
 * does not fit the window is a 400, and a 400 leaves the output verbatim,
 * which is exactly what the distillation was for.
 *
 * WHY the old `min(50_000, numCtx * 8)` was wrong twice over: the `min`
 * bound for every window at or above 6250, so a 500 KB tool result was cut
 * to 10 % of itself before the distiller saw it at 256k and at 1M alike; and
 * `numCtx * 8` CHARACTERS is about `numCtx * 2` TOKENS, which is TWICE the
 * window at small sizes — at a 2048-token window the cap allowed 16 384
 * characters (4096 tokens) against a 2048-token window, so the distillation
 * request itself 400ed and the output stayed verbatim.
 *
 * WHY the conversion is {@link DISTILL_CHARS_PER_TOKEN} (3.5) and not the
 * shared 4: the shared conversion is optimistic for the Llama/Qwen
 * tokenizers that need the scaling most, and an optimistic conversion
 * OVERSHOOTS the window by a third.
 *
 * WHY the ABSOLUTE ceiling is applied on top: the window Locopilot believes
 * is not the window the provider enforces (the OpenAI-compatible adapter
 * never sends `num_ctx`), so a window-derived cap alone can send a request
 * the provider rejects — and a rejected call leaves the output VERBATIM.
 * The cap is therefore `min(window-derived, 112 000 characters)`: 2688 at
 * 2048, 14 336 at 8192, 57 344 at 32768, and 112 000 (the absolute ceiling)
 * from a ~65 536-token window upwards.
 */
export function computeDistillInputMaxChars(numCtx: number): number {
  if (!Number.isFinite(numCtx) || numCtx <= 0) {
    return Math.min(
      TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE,
      Math.floor(TOOL_DISTILL_INPUT_MIN_TOKENS * DISTILL_CHARS_PER_TOKEN)
    );
  }
  const tokenBudget = Math.max(
    TOOL_DISTILL_INPUT_MIN_TOKENS,
    Math.min(
      Math.floor(numCtx * TOOL_DISTILL_INPUT_TOKEN_RATIO),
      numCtx - computeDistillNumPredict(numCtx) - TOOL_DISTILL_INPUT_OVERHEAD_TOKENS
    )
  );
  return Math.min(
    TOOL_DISTILL_INPUT_MAX_CHARS_ABSOLUTE,
    Math.floor(tokenBudget * DISTILL_CHARS_PER_TOKEN)
  );
}

/**
 * The largest DIGEST the distiller's answer may be, in characters.
 *
 * WHY the cap is the LARGER of the two bounds and not the smaller: the
 * digest IS the model's answer. A cap below what the model can emit CUTS
 * that answer mid-sentence, and a digest that stops mid-sentence carries no
 * signal that it was cut — the summariser then copies a fragment as if it
 * were the whole value. The old flat 2400-character cap did exactly that at
 * every window up to ~205 000 tokens.
 *
 * The two bounds:
 *
 * - the MODEL'S OUTPUT CAPACITY: `computeDistillNumPredict(numCtx)` tokens at
 *   {@link DISTILL_OUTPUT_CHARS_PER_TOKEN} (5) characters, plus room for the
 *   truncation marker. 5140 characters at every window up to 262 144,
 *   10 260 at 524 288, 20 500 at 1 048 576.
 * - the WINDOW SHARE: {@link TOOL_DISTILL_MAX_CHARS_WINDOW_RATIO} (2 %) of
 *   the window — 5242 characters at 262 144, 20 971 at 1 048 576.
 *
 * WHICH BINDS: the output capacity binds at every window up to ~257 000
 * tokens (the window share is still below it there), and the window share
 * binds above that. The ceiling
 * ({@link TOOL_DISTILL_DIGEST_MAX_CHARS_CEILING}, 24 000) is above the
 * largest capacity the model can reach, so it can never be the thing that
 * cuts the answer.
 */
export function computeDistillDigestMaxChars(numCtx: number): number {
  const capacity =
    computeDistillNumPredict(numCtx) * DISTILL_OUTPUT_CHARS_PER_TOKEN +
    TOOL_DISTILL_TRUNCATION_MARKER.length;
  const windowShare =
    Number.isFinite(numCtx) && numCtx > 0
      ? Math.floor(numCtx * TOOL_DISTILL_MAX_CHARS_WINDOW_RATIO)
      : 0;
  return Math.min(TOOL_DISTILL_DIGEST_MAX_CHARS_CEILING, Math.max(capacity, windowShare));
}

/**
 * The number of PREFILL tokens a string of `chars` characters costs.
 *
 * WHY the conservative conversion: this number is what the prefill budget
 * is denominated in, and an optimistic conversion would let the compaction
 * spend twice the prefill it budgeted for.
 */
export function estimateDistillPrefillTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) {
    return 0;
  }
  return Math.ceil(chars / DISTILL_CHARS_PER_TOKEN);
}

/**
 * The PREFILL tokens ONE compaction may spend on distillation, across every
 * distillation call it makes.
 *
 * WHY the total has to be bounded and not only the NUMBER of calls: the call
 * cap saturates at 8, but the per-call input grew 40x (50 000 characters to
 * 2 000 000). Eight calls at 500k tokens each is ~4M tokens of prefill
 * inside ONE compaction — several times the window the compaction is trying
 * to shrink, and the reason a compaction at a 1M window became about three
 * times as expensive as it had been.
 *
 * The budget is one window's worth
 * ({@link TOOL_DISTILL_PREFILL_BUDGET_WINDOW_RATIO}): the summarisation
 * request is allowed 60 % of the window
 * ({@link SAFE_INPUT_BUDGET_RATIO}), so the whole compaction stays at
 * roughly 2.5x its old cost instead of an unbounded multiple.
 *
 * WHY a window that is not a positive finite number gets the DEFAULT and not
 * zero: a caller that did not thread its window through must still be able
 * to distil something.
 */
export function computeDistillPrefillBudgetTokens(numCtx: number): number {
  if (!Number.isFinite(numCtx) || numCtx <= 0) {
    return TOOL_DISTILL_PREFILL_BUDGET_DEFAULT_TOKENS;
  }
  return Math.max(0, Math.floor(numCtx * TOOL_DISTILL_PREFILL_BUDGET_WINDOW_RATIO));
}

/**
 * The timeout of ONE distillation call, given the size of its request.
 *
 * WHY the call needs one at all: the distillation request used to be sent
 * with NO timeout, so a 500k-token prefill against a slow provider could
 * hang the compaction indefinitely — the request neither failed nor
 * returned.
 *
 * WHY it scales: the prefill is the slow part (the model reads the tool
 * output before it writes anything) and the output is the second slow part.
 * A flat 60-second timeout would kill every large distillation call; a flat
 * ten-minute timeout would let a small one hang for ten minutes.
 *
 * WHY there is a ceiling: the timeout scales with the request, so an
 * unbounded request would produce an unbounded timeout.
 */
export function computeDistillTimeoutMs(prefillTokens: number, numPredict: number): number {
  const prefill = Math.max(0, Math.ceil(prefillTokens / 1000));
  const output = Math.max(0, Math.ceil(numPredict / 1000));
  const total =
    TOOL_DISTILL_TIMEOUT_BASE_MS +
    prefill * TOOL_DISTILL_TIMEOUT_MS_PER_1K_PREFILL_TOKENS +
    output * TOOL_DISTILL_TIMEOUT_MS_PER_1K_OUTPUT_TOKENS;
  return clamp(total, TOOL_DISTILL_TIMEOUT_BASE_MS, TOOL_DISTILL_TIMEOUT_MAX_MS);
}

/**
 * The token budget for the INPUT of a single summarisation request. Kept well
 * below the model context window so the request never approaches the hard
 * limit (which causes 400 "prompt is too long" failures).
 */
export function computeSafeInputBudget(numCtx: number): number {
  return Math.max(256, Math.floor(numCtx * SAFE_INPUT_BUDGET_RATIO));
}

/**
 * The token budget left for the HISTORY once the instruction prompt has been
 * paid for.
 *
 * WHY the floor applies to the TOTAL and not to the subtraction: a floor on
 * the subtraction (`max(256, safe - prompt)`) DISCARDS the subtraction
 * whenever the prompt is bigger than the budget minus 256 tokens. At a small
 * context window the prompt was then charged NOTHING and the request could
 * exceed the window (at a 512-token context: 996 tokens sent against a
 * 512-token window — the provider rejects it). The prompt is part of the
 * request, so it is always paid for; what is left is what the history may
 * use, and it is floored at ZERO (a history allowance of zero is a pipeline
 * that must fail loudly, not one that silently sends an over-budget request).
 *
 * This is the ONE place the arithmetic lives: the callers ask for the
 * allowance and never do the subtraction themselves.
 */
export function computeEffectiveInputBudget(safeInputBudget: number, promptTokens: number): number {
  return Math.max(0, safeInputBudget - promptTokens);
}

/**
 * Computes the target/min/max summary token budgets for one summarisation
 * request given the size of the source it is compressing.
 *
 * @param numCtx             - The effective model context window.
 * @param aggressiveFactor   - >1 when the caller wants stronger compression.
 * @param sourceTokenEstimate - Estimated tokens of the source being summarised.
 */
export function computeSummaryBudget(
  numCtx: number,
  aggressiveFactor: number,
  sourceTokenEstimate: number
): SummaryBudget {
  const rawMaxSummaryTokens = clamp(
    Math.floor((numCtx * SUMMARY_MAX_TOKENS_RATIO) / aggressiveFactor),
    Math.max(
      MAX_SUMMARY_TOKENS_FLOOR,
      Math.floor((numCtx * MAX_SUMMARY_TOKENS_FLOOR_RATIO) / aggressiveFactor)
    ),
    Math.max(
      MAX_SUMMARY_TOKENS_CEILING,
      Math.floor((numCtx * MAX_SUMMARY_TOKENS_CEILING_RATIO) / aggressiveFactor)
    )
  );
  // Cap the summary budget so it can never exceed the source it is compressing.
  // Without this a tiny conversation gets a confusingly large target, which can
  // cause some models to output nothing.
  const sourceCappedMaxSummaryTokens = Math.max(
    50,
    Math.floor(sourceTokenEstimate * SOURCE_CAP_RATIO)
  );
  const maxSummaryTokens = Math.min(rawMaxSummaryTokens, sourceCappedMaxSummaryTokens);
  const rawTargetSummaryTokens = clamp(
    Math.floor((numCtx * SUMMARY_TARGET_TOKENS_RATIO) / aggressiveFactor),
    Math.max(
      MAX_TARGET_TOKENS_FLOOR,
      Math.floor((numCtx * MIN_TARGET_TOKENS_RATIO) / aggressiveFactor)
    ),
    rawMaxSummaryTokens
  );
  const targetSummaryTokens = clamp(
    Math.min(rawTargetSummaryTokens, maxSummaryTokens),
    50,
    maxSummaryTokens
  );
  const minSummaryTokens = Math.max(50, Math.floor(targetSummaryTokens * MIN_SUMMARY_TOKENS_RATIO));
  return { targetSummaryTokens, minSummaryTokens, maxSummaryTokens };
}

/**
 * The output limit (`num_predict`) of one summarisation request: the target
 * plus a buffer, never below the minimum, never above the window.
 *
 * The summary is the model's only memory of the compacted turns, so the limit
 * must not cut it: the buffer lets a summary run a little over its target, and
 * the window is the only hard ceiling.
 *
 * @param budget - the request's target/min/max summary budget.
 * @param numCtx - the model's context window.
 */
export function computeSummaryOutputAllowance(budget: SummaryBudget, numCtx: number): number {
  return Math.min(
    numCtx,
    Math.max(
      Math.floor(budget.targetSummaryTokens * SUMMARY_NUM_PREDICT_BUFFER_RATIO),
      budget.minSummaryTokens
    )
  );
}
