/**
 * windowTrim.ts
 *
 * Makes room when a compaction does not get under the acceptance budget by
 * DROPPING the oldest messages of the preserved recent window.
 *
 * WHY this exists: the pipeline used to respond to a result that was still too
 * big by recursively compacting the ALREADY-compacted array — a summary of a
 * summary. That is the worst quality leak in the pipeline: the second pass has
 * no dialogue left to read, only the first summary, so every fact the first
 * pass compressed further is now one paraphrase away from being wrong. The
 * preserved recent window, by contrast, is just older recent turns: dropping
 * its head costs CONTEXT but not FIDELITY, and it costs no model call at all.
 *
 * The planner is PURE: it returns the messages to keep plus what it dropped,
 * and never touches the history. `orchestrate.ts` owns the rebuild and the
 * notice it appends to the summary.
 *
 * INVARIANTS (all covered by scripts/test-compact-trim.mjs):
 *
 * 1. SUBSEQUENCE. `messages` is a subsequence of `preserved` — EXCEPT that the
 *    latest real user message may be hoisted to index 0 (see rule 3 below), in
 *    which case it appears exactly once, never twice.
 * 2. THE ANCHOR SURVIVES. The latest real (non-synthetic) user message is
 *    always present. It is the request the model is working on; a window that
 *    lost it is a window the model cannot act on. When the window holds no
 *    real user message, the LAST user-role row (a synthetic nudge, if that is
 *    all there is) is the anchor instead — otherwise a nudge-only window lost
 *    every user-role row it had.
 * 3. NO ORPHAN HEAD. After a non-zero drop, `messages[0].role !== 'tool'` and
 *    `messages.length >= 1`. A tool result whose assistant call was dropped is
 *    not context, it is a fragment the model cannot even attribute.
 * 4. THE LAST MESSAGE IS NEVER DROPPED ("never" = a hard limit on the cut,
 *    `preserved.length - MIN_TRAILING_WINDOW_MESSAGES`). It is the turn in
 *    flight — usually the user's prompt or the tool result the model is about
 *    to read.
 * 5. `droppedCount === 0` ⟺ the stop reason is `already-fits` or
 *    `nothing-droppable`. A plan that says it trimmed but dropped nothing
 *    would make the caller append a notice that describes nothing.
 * 6. TERMINATION. The cut is monotonically advanced and is bounded by the hard
 *    limit, so the exact-recount loop runs at most `preserved.length` times
 *    and always returns.
 */

import type { ChatMessage } from '@/services/llm';

import { countMessagesTokens, countMessageTokens } from '@/services/tokenizer';

import { MIN_TRAILING_WINDOW_MESSAGES } from './constants';
import { findLatestUserMessageIndex } from './split';

/**
 * Why the trimmer stopped.
 *
 * - `already-fits`        — nothing needed dropping; `messages` is untouched.
 * - `trimmed`             — the trimmed window fits the budget.
 * - `trimmed-insufficient` — everything droppable was dropped and the result
 *                            is STILL over budget (the caller falls back to a
 *                            stronger pass).
 * - `nothing-droppable`   — trimming could not help: the window is a single
 *                            message, or every candidate cut would have left an
 *                            orphan tool row at the head, or only the anchor
 *                            could have been removed.
 */
export type WindowTrimStopReason =
  | 'already-fits'
  | 'trimmed'
  | 'trimmed-insufficient'
  | 'nothing-droppable';

/**
 * The tokens the preserved window may occupy: the acceptance boundary minus
 * everything the compaction cannot drop.
 *
 * Four charges, and each one is a token the RESULT will carry whether the
 * window is trimmed or not:
 *
 * - `headerTokens` — the summary message (preamble + summary).
 * - `noticeTokens` — the trim notice, charged at its WORST CASE (every
 *   preserved message dropped) so the budget is fixed before the planner runs
 *   instead of depending on what it ends up dropping.
 * - `systemPromptTokens` — the system prompt. `newMessages` does not carry it
 *   (the caller re-prepends its own) but the request that follows does, and
 *   the acceptance test in `orchestrate.ts` counts it. Leaving it out here was
 *   a REAL bug: the planner trimmed until the WINDOW fitted a budget that
 *   still had room for the system prompt, the post-trim TOTAL was then over by
 *   exactly the system prompt, `shouldRetry` stayed true, and the
 *   summary-of-a-summary recursion fired anyway — the very thing the trim
 *   exists to avoid. Measured at numCtx 8192 with a 3712-token system prompt:
 *   budget 6890 (system omitted) → `dropped=0, already-fits`, post-trim 7540,
 *   retry; budget 3178 (system charged) → `dropped=1, trimmed`, post-trim 6999,
 *   accepted.
 *
 * The result may be ZERO OR NEGATIVE — that is the degenerate case where the
 * system prompt (plus the summary header) alone exceeds the acceptance
 * budget. It is not an error: {@link planWindowTrim} reads a budget it cannot
 * meet as "drop everything you legally can", and the caller's retry/notice
 * path then reports that the result is still over.
 */
export function computePreservedWindowBudget(params: {
  /** The acceptance boundary: `floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM)`. */
  acceptanceBudget: number;
  /** The tokens of the summary message the result will always carry. */
  headerTokens: number;
  /** The worst-case tokens of the trim notice. */
  noticeTokens: number;
  /** The tokens of the system prompt the next request will carry. */
  systemPromptTokens: number;
}): number {
  return (
    params.acceptanceBudget - params.headerTokens - params.noticeTokens - params.systemPromptTokens
  );
}

/** The outcome of {@link planWindowTrim}. */
export interface WindowTrimPlan {
  /** The messages to keep (a subsequence of the input, plus any hoisted anchor). */
  messages: ChatMessage[];
  /** How many messages were removed (the hoisted anchor is not one of them). */
  droppedCount: number;
  /** The tokens those messages carried, as the local tokenizer counted them. */
  droppedTokens: number;
  stopReason: WindowTrimStopReason;
}

/**
 * Drops the oldest messages of a preserved window until it fits `windowBudget`.
 *
 * The cut is a PREFIX cut, so what survives is the newest contiguous run of the
 * window. The latest real user message is never dropped: if the cut would pass
 * it, the message is HOISTED to the front of the result (exactly once). Without
 * the hoist nothing at all would be droppable in the common mid-turn case,
 * where the anchor is the first message of the window — and `split.ts` already
 * hoists the anchor in its own path, so the shape is not new to the pipeline.
 *
 * The anchor is counted as part of the result but never subtracted from the
 * running total, because it is not being removed.
 *
 * The anchor is the latest REAL user message, but a window whose only user row
 * is a synthetic nudge falls back to that nudge (see {@link findTrimAnchorIndex}).
 *
 * @param preserved    - The preserved recent window (may be empty).
 * @param windowBudget - Tokens the window may occupy. May be 0 or negative
 *                       when the summary header already exceeds the budget;
 *                       the trimmer then drops everything it legally can.
 * @param model        - Model name, for the cached tokenizer encoder.
 */
export function planWindowTrim(
  preserved: ChatMessage[],
  windowBudget: number,
  model: string
): WindowTrimPlan {
  const unchanged = (stopReason: WindowTrimStopReason): WindowTrimPlan => ({
    messages: preserved,
    droppedCount: 0,
    droppedTokens: 0,
    stopReason,
  });

  if (preserved.length === 0) {
    return unchanged('already-fits');
  }

  const total = countMessagesTokens(preserved, model);
  if (total <= windowBudget) {
    return unchanged('already-fits');
  }

  // A trailing count of at least one message is never dropped (invariant 4).
  const maxCut = preserved.length - MIN_TRAILING_WINDOW_MESSAGES;
  if (maxCut <= 0) {
    return unchanged('nothing-droppable');
  }

  const anchorIndex = findTrimAnchorIndex(preserved);
  const tokenCosts = preserved.map((message) => countMessageTokens(message, model));

  // ── Step 1: accumulate a prefix cut from the FREE per-message counts ──────
  // The anchor is skipped (never dropped) but stays in the running total: it
  // is still part of the result.
  let cut = 0;
  let accounted = total;
  while (accounted > windowBudget && cut < maxCut) {
    if (cut !== anchorIndex) {
      accounted -= tokenCosts[cut] ?? 0;
    }
    cut += 1;
  }

  // ── Step 2: exact recount, block-aligned ─────────────────────────────────
  // Every iteration either returns or advances the cut past the aligned one,
  // so the loop is bounded by `maxCut` (invariant 6).
  for (;;) {
    const aligned = alignCut(preserved, cut, maxCut);
    if (aligned === null) {
      // No legal cut exists: every candidate would either orphan a tool row
      // or drop the last message. Dropping nothing is the only safe answer.
      return unchanged('nothing-droppable');
    }

    const built = buildPlan(preserved, aligned, anchorIndex, tokenCosts);
    const fits = countMessagesTokens(built.messages, model) <= windowBudget;

    if (fits || aligned >= maxCut) {
      if (built.droppedCount === 0) {
        return unchanged('nothing-droppable');
      }
      return {
        messages: built.messages,
        droppedCount: built.droppedCount,
        droppedTokens: built.droppedTokens,
        stopReason: fits ? 'trimmed' : 'trimmed-insufficient',
      };
    }

    const next = aligned + 1;
    if (next <= cut) {
      // Alignment backed OFF to the start of a tool run (see `alignCut`), so
      // advancing would only find the same run again. This is the best legal
      // plan there is — unless it dropped nothing at all, which is not a trim.
      if (built.droppedCount === 0) {
        return unchanged('nothing-droppable');
      }
      return {
        messages: built.messages,
        droppedCount: built.droppedCount,
        droppedTokens: built.droppedTokens,
        stopReason: 'trimmed-insufficient',
      };
    }
    cut = next;
  }
}

/**
 * The index the trimmer must never drop: the latest real user message, or —
 * when the window holds no real user message at all — the LAST `role ===
 * 'user'` row, nudge included.
 *
 * WHY the fallback: `findLatestUserMessageIndex` deliberately skips synthetic
 * nudges, so a window of `[nudge, assistant, assistant]` returned -1 and the
 * trim dropped every user-role row, leaving a window the model cannot act on
 * (a summary plus assistant turns, with no request in it). A nudge is not a
 * real prompt, but it IS the closest thing to one this window has, so it is a
 * better anchor than nothing. The splitter keeps skipping nudges: there, a
 * nudge anchor would let a REAL user prompt sitting earlier in the history be
 * summarised away, and that prompt is not in the same window.
 *
 * @returns the anchor index, or -1 when the window has no user row at all.
 */
function findTrimAnchorIndex(preserved: ChatMessage[]): number {
  const latestRealUserIndex = findLatestUserMessageIndex(preserved);
  if (latestRealUserIndex >= 0) {
    return latestRealUserIndex;
  }
  for (let index = preserved.length - 1; index >= 0; index -= 1) {
    if (preserved[index]?.role === 'user') {
      return index;
    }
  }
  return -1;
}

/**
 * Moves a candidate cut off a `tool` row, so the result never starts with a
 * tool result whose assistant call was dropped.
 *
 * Alignment normally moves FORWARD. It moves BACKWARD only when the run of
 * tool rows it landed in extends past the hard limit: a window that ENDS on a
 * tool result cannot be cut inside that final block without dropping the last
 * message (invariant 4), so the last legal cut is the start of that block —
 * which keeps the assistant and its result together, at the price of dropping
 * less than the budget asked for.
 *
 * @returns the aligned cut, or `null` when NO legal cut exists (the window
 *          itself begins with tool rows, so any cut would orphan one).
 */
function alignCut(preserved: ChatMessage[], cut: number, maxCut: number): number | null {
  let forward = cut;
  while (forward < preserved.length && preserved[forward]?.role === 'tool') {
    forward += 1;
  }

  if (forward <= maxCut) {
    return forward;
  }

  let backward = cut;
  while (backward > 0 && preserved[backward]?.role === 'tool') {
    backward -= 1;
  }
  return preserved[backward]?.role === 'tool' ? null : backward;
}

/**
 * Builds the result for one candidate cut, WITHOUT counting it.
 *
 * `anchorIndex < cut` is the hoist case: the cut would have removed the latest
 * user message, so it is re-inserted at the front and counts as kept.
 */
function buildPlan(
  preserved: ChatMessage[],
  cut: number,
  anchorIndex: number,
  tokenCosts: number[]
): { messages: ChatMessage[]; droppedCount: number; droppedTokens: number } {
  if (cut <= 0) {
    return { messages: preserved, droppedCount: 0, droppedTokens: 0 };
  }

  const hoistAnchor = anchorIndex >= 0 && anchorIndex < cut;
  const anchorMessage = hoistAnchor ? preserved[anchorIndex] : undefined;
  const messages =
    anchorMessage === undefined ? preserved.slice(cut) : [anchorMessage, ...preserved.slice(cut)];

  let droppedCount = 0;
  let droppedTokens = 0;
  for (let index = 0; index < cut; index += 1) {
    if (index === anchorIndex) {
      continue;
    }
    droppedCount += 1;
    droppedTokens += tokenCosts[index] ?? 0;
  }

  return { messages, droppedCount, droppedTokens };
}
