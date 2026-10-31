/**
 * budget.ts
 *
 * Pure token-budget maths for the compaction pipeline. All sizing decisions —
 * safe input budgets, per-request summary targets, and chunk boundaries — are
 * computed here so the orchestration logic stays free of magic numbers.
 */

import type { SummaryBudget } from './types';

import {
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
} from './constants';

export function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
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
