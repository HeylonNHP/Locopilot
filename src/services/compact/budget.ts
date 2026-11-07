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
  SUMMARY_TARGET_TOKENS_RATIO,
  TOOL_DISTILL_CALLS_PER_WINDOW,
  TOOL_DISTILL_MAX_CALLS,
  TOOL_DISTILL_MIN_CALLS,
} from './constants';

export function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

/**
 * The token margin auto-compaction RESERVES for the reply and for the next
 * request, given the model's context window.
 *
 * The reserve is 25 % of the window, clamped to `[1500, 13000]` so that a tiny
 * local model is not asked to give up a whole prompt's worth of history and a
 * 1M-token window does not reserve a quarter of a million tokens nobody needs
 * — then capped at 40 % of the window (see
 * `COMPACT_RESERVE_MAX_WINDOW_RATIO`), because on a 2048-token window the
 * clamp alone would reserve 27 % and compaction would fire constantly.
 */
export function computeCompactionReserveTokens(numCtx: number): number {
  if (!Number.isFinite(numCtx) || numCtx <= 0) {
    return 0;
  }
  const reserve = clamp(
    Math.floor(numCtx * COMPACT_RESERVE_RATIO),
    COMPACT_RESERVE_MIN_TOKENS,
    COMPACT_RESERVE_MAX_TOKENS
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
