/**
 * distillPlan.ts
 *
 * The pure half of the tool-output distillation: which outputs get a digest call
 * (the call cap and the prefill budget), how one is truncated and cut, how a
 * failure is described, and how a tool row finds the call it answers. No model
 * call, no progress, no state beyond the budget object the caller hands in.
 *
 * `distillToolMessages` (distill.ts) is the shell that runs the calls and
 * records the calibration sample; everything it decides BEFORE a request is
 * sent, and everything it formats AFTER, is here.
 */

import { type ChatMessage, type ToolCall } from '@/services/llm';

import {
  computeDistillPrefillBudgetTokens,
  estimateDistillPrefillTokens,
} from './budget';
import {
  TOOL_DISTILL_CHAR_THRESHOLD,
  TOOL_DISTILL_INPUT_OVERHEAD_TOKENS,
  TOOL_DISTILL_TRUNCATION_MARKER,
} from './constants';
import { findOwningAssistantIndex } from './split';

/**
 * Cuts `text` to `maxChars` characters and marks the cut when there was one.
 *
 * The marker counts towards the limit, so the result never exceeds
 * `maxChars`. A text that fits is returned unchanged — no marker, because a
 * marker on an intact digest would tell the summariser that a complete
 * digest was cut.
 */
export function cutWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const room = Math.max(0, maxChars - TOOL_DISTILL_TRUNCATION_MARKER.length);
  return `${text.slice(0, room)}${TOOL_DISTILL_TRUNCATION_MARKER}`;
}

/**
 * The marker that says how much of a tool output the distiller actually saw.
 *
 * WHY it has to be exact: the summariser's prompt tells the model to report a
 * value that was cut as cut, and the distiller is the only place that knows
 * what the summariser will never see. A marker that said "truncated" and
 * nothing else leaves the summariser unable to tell a whole value from a
 * fragment, so it copies a fragment as if it were the whole thing.
 *
 * @param kept  - how many characters of the output were sent.
 * @param total - how many characters the output has in all.
 */
function formatDistillInputTruncationMarker(kept: number, total: number): string {
  return (
    `\n\n[...truncated: only the first ${kept} of ${total} characters of this tool ` +
    `output were sent to the distiller; the remaining ${total - kept} characters were NOT included]`
  );
}

/**
 * Cuts a tool output to the distiller's input cap and says how much was cut.
 *
 * WHY the kept count is SOLVED for rather than guessed: the marker has to fit
 * INSIDE the cap, so the kept text is the cap minus the marker — and the
 * marker's own length depends on the numbers it quotes. Each pass renders the
 * marker for the current guess and shrinks the guess by the marker's length;
 * the marker only ever gets shorter as the count shrinks (fewer digits), so
 * this converges in one or two passes. The result never exceeds the cap.
 *
 * The kept count is the length of the SLICE, never the raw length: the
 * marker says how much of the output the distiller will see, and that is the
 * slice, not the whole thing.
 *
 * @param content  - the tool output.
 * @param maxChars - the largest number of characters the request may carry.
 */
export function truncateToolOutputForDistillation(
  content: string,
  maxChars: number
): { text: string; keptChars: number; totalChars: number; truncated: boolean } {
  const totalChars = content.length;
  if (totalChars <= maxChars) {
    return { text: content, keptChars: totalChars, totalChars, truncated: false };
  }
  let kept = Math.max(0, maxChars);
  let marker = formatDistillInputTruncationMarker(kept, totalChars);
  for (let pass = 0; pass < 8 && kept + marker.length > maxChars; pass += 1) {
    kept = Math.max(0, maxChars - marker.length);
    marker = formatDistillInputTruncationMarker(kept, totalChars);
  }
  // A cap smaller than the marker itself cannot hold the marker. The text is
  // cut to the cap and left unmarked, which is the lesser evil next to
  // sending more than the cap allows.
  if (kept + marker.length > maxChars) {
    return { text: content.slice(0, maxChars), keptChars: maxChars, totalChars, truncated: true };
  }
  return {
    text: `${content.slice(0, kept)}${marker}`,
    keptChars: kept,
    totalChars,
    truncated: true,
  };
}

/**
 * The tool call that the tool message at `toolIndex` answers, matched by
 * `tool_call_id` against the assistant row that heads its contiguous tool
 * block; `undefined` for an orphan (no id, or no call in that block has it).
 *
 * WHY the CALL and not the assistant row: one assistant turn can make several
 * calls, and a digest must name the call it answers, not the turn's first.
 *
 * Exported for unit tests.
 */
export function findOwningToolCall(
  messages: ChatMessage[],
  toolIndex: number
): ToolCall | undefined {
  const owner = findOwningAssistantIndex(messages, toolIndex);
  if (owner < 0) return undefined;
  const toolCallId = messages[toolIndex]?.tool_call_id;
  return messages[owner]?.tool_calls?.find((tc) => tc?.id === toolCallId);
}

/**
 * The distillation PREFILL budget of ONE compaction.
 *
 * WHY the total has to be bounded and not only the NUMBER of calls: the call
 * cap saturates at 8, but the per-call input grew 40x (50 000 characters to
 * 2 000 000). Eight calls at 500k tokens each is ~4M tokens of prefill
 * inside ONE compaction — several times the window the compaction is trying
 * to shrink, and the reason a compaction at a 1M-token window became about
 * three times as expensive as it had been.
 *
 * The budget is spent LARGEST FIRST: the biggest tool outputs are the ones
 * that decide whether the compacted history fits, and they are also the most
 * expensive to distil, so they are the ones worth the budget.
 */
export interface DistillBudget {
  /** The prefill tokens this compaction may spend on distillation in total. */
  totalTokens: number;
  /** The prefill tokens the earlier passes of this compaction already spent. */
  usedTokens: number;
}

/**
 * The prefill budget of a compaction with the given window.
 *
 * @param numCtx - the model's context window.
 */
export function createDistillBudget(numCtx: number): DistillBudget {
  return { totalTokens: computeDistillPrefillBudgetTokens(numCtx), usedTokens: 0 };
}

/**
 * How many prefill tokens are left in a budget.
 *
 * WHY a missing budget means "unlimited": a caller that does not pass one
 * (the old behaviour) keeps its old semantics — the calls it asks for are the
 * calls it gets.
 *
 * @param budget - the compaction's budget, if it has one.
 */
export function remainingDistillBudgetTokens(budget?: DistillBudget): number {
  if (!budget) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, budget.totalTokens - budget.usedTokens);
}

/** One planned distillation call. */
export interface DistillCall {
  /** The index of the tool message to distil. */
  index: number;
  /** The prefill tokens the call is charged against the budget. */
  prefillTokens: number;
}

/** The calls one pass will make, and what the budget left out. */
export interface DistillCallPlan {
  /** The calls to make, in the order the history is walked (ascending index). */
  calls: DistillCall[];
  /** How many of the selected candidates the budget could not pay for. */
  budgetSkipped: number;
  /** The prefill tokens the plan spends. */
  prefillTokens: number;
}

/** Largest output first; the same size is ordered by index, so the plan is deterministic. */
function largestFirst(
  left: { index: number; length: number },
  right: { index: number; length: number }
): number {
  return right.length - left.length || left.index - right.index;
}

/**
 * Turns the selected candidates into the calls that can be AFFORDED.
 *
 * WHY the budget is spent largest first: the biggest outputs are the ones
 * that decide whether the compacted history fits, and they are the most
 * expensive to distil — so they are the ones worth the budget, and a small
 * output that still fits in what is left is a better use of it than
 * nothing.
 *
 * WHY a candidate the budget cannot pay for is skipped rather than allowed
 * to overshoot: the budget is what keeps one compaction's distillation from
 * costing several windows' worth of prefill.
 *
 * @param historyMessages - the slice being distilled.
 * @param selectedIndices - the candidates the call cap chose.
 * @param perCallMaxChars - the largest number of characters one call may carry.
 * @param budgetTokens    - the prefill tokens the pass may spend.
 */
export function planDistillCalls(
  historyMessages: ChatMessage[],
  selectedIndices: number[],
  perCallMaxChars: number,
  budgetTokens: number
): DistillCallPlan {
  const candidates = selectedIndices
    .map((index) => ({ index, length: historyMessages[index]?.content?.length ?? 0 }))
    .sort(largestFirst);

  let remaining = budgetTokens;
  let budgetSkipped = 0;
  let prefillTokens = 0;
  const calls: DistillCall[] = [];
  for (const candidate of candidates) {
    const sentChars = Math.min(candidate.length, perCallMaxChars);
    const cost = estimateDistillPrefillTokens(sentChars) + TOOL_DISTILL_INPUT_OVERHEAD_TOKENS;
    if (cost > remaining) {
      budgetSkipped += 1;
      continue;
    }
    remaining -= cost;
    prefillTokens += cost;
    calls.push({ index: candidate.index, prefillTokens: cost });
  }
  calls.sort((left, right) => left.index - right.index);
  return { calls, budgetSkipped, prefillTokens };
}

/**
 * The plan for ONE distillation pass: which rows to digest, what the calls
 * cost, and what the caps left behind.
 *
 * WHY it is a single function: the candidate selection ({@link planDistillation})
 * and the affordability ({@link planDistillCalls}) are two halves of ONE
 * decision, and the EXTRA spend (the second pass over the preserved window,
 * once the trim has proved not to be enough) has to make exactly the same
 * decision with exactly the same rules — only over the rows the first pass
 * never touched. A separate code path for the extra spend would be a second
 * place for the two to drift apart, and the drift would be invisible: both
 * would look right.
 */
export interface DistillPassPlan {
  /** The calls to make, in the order the history is walked (ascending index). */
  calls: DistillCall[];
  /** How many eligible outputs the call cap left behind. */
  capSkipped: number;
  /** How many eligible outputs the prefill budget could not pay for. */
  budgetSkipped: number;
  /** How many eligible outputs there were in this slice. */
  candidateCount: number;
  /** How many oversized rows had no owning assistant row in this slice. */
  orphanCount: number;
  /** The prefill tokens the plan spends. */
  prefillTokens: number;
}

/**
 * Plans ONE distillation pass.
 *
 * The plan is PURE: it touches no model and no filesystem, and it is the
 * whole of the extra-spend decision — how many calls are affordable, and
 * which outputs they are spent on.
 *
 * @param historyMessages - the slice being distilled.
 * @param maxCalls        - how many model calls the pass may make.
 * @param perCallMaxChars - the largest number of characters one call may carry.
 * @param budgetTokens    - the prefill tokens the pass may spend.
 * @param thresholdChars  - the smallest output that is worth a call.
 * @param excludeIndices  - rows an earlier pass already dealt with.
 */
export function planDistillPass(params: {
  historyMessages: ChatMessage[];
  maxCalls: number;
  perCallMaxChars: number;
  budgetTokens: number;
  thresholdChars?: number;
  excludeIndices?: ReadonlySet<number>;
}): DistillPassPlan {
  const selection = planDistillation(
    params.historyMessages,
    params.maxCalls,
    params.thresholdChars,
    params.excludeIndices
  );
  const callPlan = planDistillCalls(
    params.historyMessages,
    selection.selected,
    params.perCallMaxChars,
    params.budgetTokens
  );
  return {
    calls: callPlan.calls,
    capSkipped: selection.skipped,
    budgetSkipped: callPlan.budgetSkipped,
    candidateCount: selection.selected.length + selection.skipped,
    orphanCount: selection.orphans,
    prefillTokens: callPlan.prefillTokens,
  };
}

/**
 * What a failed distillation call failed WITH, in words a progress line can
 * show.
 *
 * WHY the failure has to be NAMED: a failed call leaves the tool output
 * VERBATIM — the thing the distillation existed to prevent — so the progress
 * line has to say that it happened and why, or the compaction silently
 * returns a history that is as big as it was.
 *
 * @param err - the thrown value.
 */
export function describeDistillFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed?\s?out/i.test(message)) {
    return 'the request timed out';
  }
  if (/abort/i.test(message)) {
    return 'the request was aborted';
  }
  return 'the provider returned an error';
}

/**
 * Chooses WHICH oversized tool outputs are worth a distillation call.
 *
 * Candidate = a `tool` row whose content reaches `thresholdChars` AND that has
 * a matching assistant row in this slice. The orphan guard lives here (it used
 * to live in the loop) so an unmatched row is neither selected nor counted as
 * skipped: it is not something the cap chose to leave alone, it is something
 * distillation could not legally touch.
 *
 * Selection is by SIZE, largest first, ties broken by position. WHY not
 * positional (oldest first, or newest first):
 *
 * - Every call costs roughly the same and saves roughly `length − 2400`
 *   characters, so a positional policy spends calls on 1.3 KB results and
 *   leaves the 40 KB ones in place — the exact outputs that decide whether the
 *   compacted history fits.
 * - Never NEWEST first: distillation is lossy, and the newest results are the
 *   ones the model is actively reasoning about.
 *
 * The returned indices are ascending, so the caller can rebuild the history in
 * one pass.
 *
 * @param historyMessages - The slice that will be distilled.
 * @param maxCalls        - How many model calls the caller can afford.
 * @param thresholdChars  - Minimum content length that makes a row a candidate.
 * @param excludeIndices  - Rows that must NOT be distilled again — the ones an
 *                          earlier pass already turned into digests, and the
 *                          ones whose one attempt already failed. They are
 *                          neither selected nor counted as skipped: the cap
 *                          did not leave them behind, an earlier pass dealt
 *                          with them.
 * @returns the selected (ascending) indices, how many candidates the cap left
 *          behind, and how many oversized rows were orphans (not candidates at
 *          all).
 */
export function planDistillation(
  historyMessages: ChatMessage[],
  maxCalls: number,
  thresholdChars: number = TOOL_DISTILL_CHAR_THRESHOLD,
  excludeIndices?: ReadonlySet<number>
): { selected: number[]; skipped: number; orphans: number } {
  const limit = Number.isFinite(maxCalls) ? Math.max(0, Math.floor(maxCalls)) : 0;

  const candidates: { index: number; length: number }[] = [];
  let orphans = 0;
  for (let index = 0; index < historyMessages.length; index += 1) {
    const message = historyMessages[index];
    if (!message || message.role !== 'tool') {
      continue;
    }
    if (excludeIndices?.has(index)) {
      continue;
    }
    const length = message.content?.length ?? 0;
    if (length < thresholdChars) {
      continue;
    }
    if (findOwningToolCall(historyMessages, index) === undefined) {
      orphans += 1;
      continue;
    }
    candidates.push({ index, length });
  }

  candidates.sort(largestFirst);

  const selected = candidates
    .slice(0, limit)
    .map((candidate) => candidate.index)
    .sort((left, right) => left - right);

  return { selected, skipped: candidates.length - selected.length, orphans };
}
