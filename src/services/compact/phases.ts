/**
 * phases.ts
 *
 * The decisions a compaction takes AFTER it has a result: whether the local
 * estimate is trustworthy enough to decide on, how much of the preserved window
 * the trim may keep, whether the leftover distillation budget is worth spending,
 * and whether the recent-files stub may be attached.
 *
 * Each one is a step of its own because each answers a question with a different
 * cost and a different fidelity: a live measurement (a model call), a trim (free,
 * costs context), extra digests (model calls, cost the prefill budget, keep
 * fidelity) and the stub (free, costs context). `orchestrate.ts` orders them; this
 * module holds what each one does.
 *
 * Nothing here writes to the history: every phase takes a {@link ResultDraft} and
 * returns the draft it produces, or `undefined` when it has nothing to do.
 */

import { countMessagesTokens, countMessageTokens } from '@/services/tokenizer';

import { formatWindowTrimNotice, TOOL_DISTILL_EXTRA_CALLS_MAX } from './constants';
import { type DistillResult, remainingDistillBudgetTokens } from './distillPlan';
import { measureConversationTokens } from './measure';
import {
  distillPass,
  draftResult,
  exceedsAcceptance,
  type PassEnv,
  type ResultDraft,
  withMessages,
} from './pass';
import {
  type ExtraDistillOutcome,
  formatExtraDistillOutcome,
  formatTrimLine,
} from './progressText';
import { attachRecentFilesMessage, type RecentFilesPlan } from './recentFiles';
import { computePreservedWindowBudget, planWindowTrim, type WindowTrimPlan } from './windowTrim';

/**
 * What the phases decide: the draft to carry on with, and whether the result is
 * STILL over the boundary (the only question the next phase asks).
 *
 * A phase that did nothing returns `undefined` — the caller's draft and verdict
 * stand as they were — so "nothing happened" and "something happened that left
 * the result exactly as it was" are different answers, and only the first leaves
 * the progress output silent.
 */
export interface PhaseOutcome {
  readonly draft: ResultDraft;
  readonly overBudget: boolean;
  /** The trim that ran, for the diagnostic. `undefined` when the phase did not trim. */
  readonly trim?: WindowTrimPlan | undefined;
  /** The live count, when one was paid for. The stat stays the ESTIMATE. */
  readonly confirmedTokens?: number | undefined;
  /** What the extra spend digested and cost, for the diagnostic. */
  readonly extraDistill?: { distilledCount: number; prefillTokens: number } | undefined;
}

/**
 * The first verdict: the estimate alone decides it, UNLESS it lands inside the
 * confirmation band around the acceptance boundary, where a tokenizer's
 * few-percent error could flip the answer. Only then is ONE live measurement paid
 * for.
 *
 * WHAT the measurement actually measures — not the request shape, an
 * APPROXIMATION of it: the same messages, with `tools: []` and with NO
 * post-compaction nudge (the caller appends that after compaction), so it can
 * under-count by the size of the tool schemas. It is a prompt-eval count of the
 * conversation text only; it exists to break a tie the local tokenizer cannot,
 * not to certify the next request.
 *
 * The measured figure is used for the decision only — `stats.newTokenCount`
 * stays the estimate, so the number the UI shows is always reproducible from the
 * stored history.
 *
 * @param env    - the pass.
 * @param draft  - the freshly assembled result.
 * @param verdict - `evaluateCompactionSizes`'s answer for the same draft.
 */
export async function confirmVerdict(
  env: PassEnv,
  draft: ResultDraft,
  verdict: { retry: boolean; confirm: boolean }
): Promise<PhaseOutcome> {
  let overBudget = verdict.retry;
  let liveTokens: number | undefined;
  if (verdict.confirm) {
    const { ctx, model, numCtx, onProgress, signal, reasoningEffort } = env.request;
    // A borrowed system prompt (the retry pass) cannot be sent with the
    // measurement — the text is not in this array — so its tokens are added to
    // whatever the provider (or the fallback estimate) reports.
    const borrowedSystemPromptTokens = env.systemMessages.length === 0 ? env.systemPromptTokens : 0;
    liveTokens =
      (await measureConversationTokens(
        ctx,
        [...env.systemMessages, ...draft.messages],
        model,
        numCtx,
        onProgress,
        signal,
        reasoningEffort
      )) + borrowedSystemPromptTokens;
    overBudget = exceedsAcceptance(env, liveTokens);
  }
  return {
    draft,
    overBudget,
    ...(liveTokens === undefined ? {} : { confirmedTokens: liveTokens }),
  };
}

/**
 * The trim: drop the OLDEST preserved messages until the window fits what the
 * acceptance boundary leaves once everything the result can NOT drop is paid for.
 *
 * WHY this comes before the retry: the retry re-enters `compactHistory` on the
 * ALREADY-compacted array, so its summary is a summary of a summary — the first
 * pass's paraphrase, compressed again, with no dialogue left to check it against.
 * The preserved window is the cheap way out: it is only older recent turns,
 * dropping its oldest end costs context but not FIDELITY, it costs no model call,
 * and it works when `remainingRetries` is already 0.
 *
 * The header it charges is the SUMMARY alone. The stub is attached afterwards,
 * out of whatever room the trimmed result leaves — so it can never cause a
 * preserved turn to be dropped to fund it, and the planner is still not allowed
 * to drop anything it cannot see. The notice is charged at its WORST CASE (every
 * preserved message dropped), so the budget is fixed before the planner runs
 * instead of depending on how much it ends up dropping — a notice that only shows
 * up after the trim would otherwise push the result a few tokens back over the
 * boundary and trigger the re-summary this whole phase exists to avoid.
 *
 * @returns the trimmed draft, or `undefined` when the window was already as small
 *          as the planner may make it.
 */
export function trimPreservedWindow(env: PassEnv, draft: ResultDraft): PhaseOutcome | undefined {
  const { model } = env.request;
  const headerTokens = countMessagesTokens([draft.summary], model);
  const noticeTokens = countMessageTokens(
    { role: 'assistant', content: formatWindowTrimNotice(draft.window.length) },
    model
  );
  const windowBudget = computePreservedWindowBudget({
    acceptanceBudget: env.acceptanceBudget,
    headerTokens,
    noticeTokens,
    systemPromptTokens: env.systemPromptTokens,
  });
  const trimPlan = planWindowTrim(draft.window, windowBudget, model);
  if (trimPlan.droppedCount === 0) return undefined;
  const trimmed = draftResult(
    env,
    {
      ...draft.summary,
      content: `${draft.summary.content}${formatWindowTrimNotice(trimPlan.droppedCount)}`,
    },
    trimPlan.messages,
    trimPlan.keptIndices
  );
  env.request.onProgress?.(
    formatTrimLine(trimPlan, trimmed.overBudget, trimmed.tokens, env.acceptanceBudget)
  );
  return { draft: trimmed, overBudget: trimmed.overBudget, trim: trimPlan };
}

/** Where each original window row ended up in a draft's current window. */
export function windowPositionsBySource(draft: ResultDraft): Map<number, number> {
  const positions = new Map<number, number>();
  draft.windowSources.forEach((source, position) => positions.set(source, position));
  return positions;
}

/** The current positions of some original rows, dropping the ones the trimmer removed. */
export function positionsOf(
  sources: readonly number[],
  positions: ReadonlyMap<number, number>
): Set<number> {
  const found = new Set<number>();
  for (const source of sources) {
    const position = positions.get(source);
    if (position !== undefined) found.add(position);
  }
  return found;
}

/**
 * The rows the first window pass already dealt with, in the index space of the
 * window that is about to be walked.
 *
 * - the ones it turned into DIGESTS: a digest must never be distilled again — a
 *   digest is the model's own answer about the output and can be LONGER than the
 *   output it replaced, so distilling it again would make the window BIGGER.
 * - the ones whose call FAILED: a failure is not retried here. The provider that
 *   just refused the request will refuse it again, and the extra spend may make up
 *   to 32 calls — a failing provider would cost 32 more failures for nothing.
 *
 * What is left is exactly the set the extra spend targets: the oversized outputs
 * the call cap or the prefill budget never ATTEMPTED. The trim re-indexes the
 * window, so the digests' and failures' ORIGINAL indices are mapped through
 * `windowSources` first — without that, a failed row would be re-attempted at
 * whatever position now holds it.
 *
 * @param draft        - the window about to be walked.
 * @param recentDistill - the window pass's result.
 */
export function planHandledWindowRows(
  draft: ResultDraft,
  recentDistill: Pick<DistillResult, 'distilledIndices' | 'failedIndices'>
): { handledRows: ReadonlySet<number>; failedRows: ReadonlySet<number> } {
  const positions = windowPositionsBySource(draft);
  const failedRows = positionsOf(recentDistill.failedIndices, positions);
  const digestedRows = positionsOf(recentDistill.distilledIndices, positions);
  return { handledRows: new Set([...digestedRows, ...failedRows]), failedRows };
}

/**
 * Spend the leftover prefill budget on the preserved window BEFORE re-summarising.
 *
 * WHY here, and nowhere else: this is the one point where the compaction KNOWS
 * the result does not fit — the trim has been tried and was not enough — and the
 * only lever left that does not cost FIDELITY.
 *
 * WHY the WINDOW and not the older slice: the preserved window is kept VERBATIM
 * in the result, so digesting its tool outputs shrinks the result DIRECTLY and
 * needs NO extra summariser call. Digesting the older slice would shrink the
 * SUMMARY's input instead — which would need a whole extra summarisation pass,
 * the exact cost this phase exists to avoid.
 *
 * WHY the leftover budget is worth spending: the call cap saturates at 8, but the
 * prefill budget is ONE WINDOW. At a 262 144-token window the two bind together
 * (eight calls at ~32 000 tokens each is the whole budget), but at a
 * 1 048 576-token window the CAP binds FIRST — eight calls spend ~258 000 of
 * 1 048 576 tokens, so ~790 000 tokens of the budget went UNSPENT while the
 * oversized outputs that were not digested stayed VERBATIM in the window. A
 * verbatim tool output in the result is exactly what makes it too big, so the
 * leftover budget is worth more spent than idle.
 *
 * The extra calls are charged to the SAME budget (by `distillPass`), so the total
 * prefill of ONE compaction still respects
 * `computeDistillPrefillBudgetTokens(numCtx)`. The call ceiling
 * (`TOOL_DISTILL_EXTRA_CALLS_MAX`) is the other bound — it keeps the latency of
 * the extra spend finite.
 */
export async function spendLeftoverDistillBudget(
  env: PassEnv,
  draft: ResultDraft,
  recentDistill: Pick<DistillResult, 'distilledIndices' | 'failedIndices'>
): Promise<PhaseOutcome> {
  const { handledRows, failedRows } = planHandledWindowRows(draft, recentDistill);
  const leftoverBudgetTokens = remainingDistillBudgetTokens(env.distillBudget);
  const extraDistill = await distillPass(env, draft.window, {
    maxCalls: TOOL_DISTILL_EXTRA_CALLS_MAX,
    skipIndices: handledRows,
  });
  const summary = {
    distilledCount: extraDistill.distilledCount,
    prefillTokens: extraDistill.prefillTokens,
  };
  const announce = (outcome: ExtraDistillOutcome) =>
    env.request.onProgress?.(formatExtraDistillOutcome(outcome));

  if (extraDistill.distilledCount > 0) {
    // The digests are only KEPT when they made the result SMALLER: a digest is
    // the model's own answer about the output, and on a small output it can be
    // longer than the output itself. Spending the budget must never make the
    // result bigger.
    const digested = draftResult(env, draft.summary, extraDistill.messages, draft.windowSources);
    if (digested.tokens >= draft.tokens) {
      announce({ ...summary, kind: 'rejected' });
      return { draft, overBudget: draft.overBudget, extraDistill: summary };
    }
    announce({
      ...summary,
      kind: 'kept',
      stillOverBudget: digested.overBudget,
      newTokenCount: digested.tokens,
      acceptanceBudget: env.acceptanceBudget,
    });
    return { draft: digested, overBudget: digested.overBudget, extraDistill: summary };
  }
  if (extraDistill.candidateCount === 0) {
    // NOTHING LEFT TO SPEND ON. Two shapes reach this line: the window has no
    // oversized output at all, or every oversized output in it was already
    // distilled or already attempted (and failed).
    announce({ kind: 'nothing-left', leftoverBudgetTokens, failedRows: failedRows.size });
  } else if (extraDistill.attemptedCount === 0) {
    // The leftover budget cannot pay for even ONE call — the candidates are all
    // bigger than what is left of the budget.
    announce({
      kind: 'unaffordable',
      leftoverBudgetTokens,
      candidateCount: extraDistill.candidateCount,
    });
  } else {
    announce({
      kind: 'all-failed',
      attemptedCount: extraDistill.attemptedCount,
      candidateCount: extraDistill.candidateCount,
    });
  }
  return { draft, overBudget: draft.overBudget, extraDistill: summary };
}

/**
 * Attach the recent-files stub to the FINAL history.
 *
 * WHY a stub at all: the summary replaces every `read_file` / `patch_file` /
 * `write_file` call of the summarised turns, so the model loses the one cheap
 * fact it had — WHICH files this session is working on — and pays a full round of
 * tool calls to get it back. `session_recent_files` already remembers it (see
 * `fileTouchRecorder.ts`), and the files are still on disk, so the stub re-states
 * the working set and — when a file fits WHOLE in the per-file budget —
 * reproduces it.
 *
 * WHY an ASSISTANT message between the summary and the window:
 *
 *   - NEVER a `user`-role row. `findLatestUserMessageIndex` anchors the next
 *     compaction on the latest real user message; a user-role stub would become
 *     that anchor, and on a second compaction in the same turn the REAL prompt
 *     (which sits earlier) would be summarised away.
 *   - Between the summary and the window it reads as one unit with the summary —
 *     "this is what came before" — and chronologically it is right (the excerpts
 *     are the files as they were at compaction time). After the window it would
 *     read as the newest event in the conversation, which invites the model to
 *     answer the content of a file instead of the user's request.
 *
 * The budget is charged against `draft.tokens` — everything the finished result
 * already carries, system prompt included — and capped by
 * `min(acceptanceBudget, oldTokenCount - 1)`, so the stub can never push the
 * result past the acceptance boundary, and never back to (or past) the size of
 * the history it replaced: that would trip the `aborted` verdict and throw
 * "failed to reduce history".
 *
 * The attach is a CHECKED step, not a `splice`: `attachRecentFilesMessage`
 * returns `null` when the message would un-shrink the history or push it past the
 * boundary, and `null` is the only path on which nothing is claimed.
 *
 * @returns the draft carrying the stub and the plan (for the diagnostic and the
 *          progress line), or `undefined` when no stub was attached.
 */
export async function attachRecentFilesStub(
  env: PassEnv,
  draft: ResultDraft,
  plan: RecentFilesPlan
): Promise<{ draft: ResultDraft; plan: RecentFilesPlan } | undefined> {
  const { model } = env.request;
  const stubbedMessages = attachRecentFilesMessage({
    messages: draft.messages,
    message: { role: 'assistant', content: plan.text },
    model,
    systemPromptTokens: env.systemPromptTokens,
    oldTokenCount: env.oldTokenCount,
    acceptanceBudget: env.acceptanceBudget,
  });
  if (stubbedMessages === null) return undefined;
  return { draft: withMessages(env, draft, stubbedMessages), plan };
}
