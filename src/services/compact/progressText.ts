/**
 * progressText.ts
 *
 * What a compaction SAYS about itself: the progress lines the pass emits and the
 * `compaction_size` diagnostic it logs. Pure formatting — no model call, no
 * state, no decision. `orchestrate.ts` decides what happened and passes the
 * numbers; this module turns them into the exact words.
 *
 * The wording is part of the user-visible behaviour (the progress lines reach
 * the UI) and of the diagnostic contract (a missing key and an `undefined` key
 * look different to a log reader), so these functions are pinned by
 * `tests/compact-progress-text.test.mjs` and, end to end, by the transcripts in
 * `tests/compact-orchestrate.test.mjs`.
 */

import type { DiagnosticTraceEntry } from '@/app/lib/debugLogger';

import type { DistillResult } from './distillPlan';
import type { RecentFilesPlan } from './recentFiles';
import type { WindowTrimPlan } from './windowTrim';

import { describeRecentFilesShape } from './recentFilesRender';

/** The first line: how the history was split. */
export function formatPreparingLine(summariseCount: number, preservedCount: number): string {
  return `Preparing compaction: summarizing ${summariseCount} messages, preserving ${preservedCount} recent messages`;
}

/** What the two distillation passes (the preserved window, then the older slice) cost and left behind. */
export interface DistillationReportInput {
  /** The preserved window's pass. */
  window: DistillResult;
  /** The older slice's pass. */
  history: DistillResult;
  /** The compaction's prefill budget (tokens). */
  budgetTotalTokens: number;
  /** The call cap for the window's size. */
  callCap: number;
  /** The model's context window. */
  numCtx: number;
}

/**
 * The distillation summary line, and — when something large stayed verbatim — the
 * line that says why.
 *
 * The summary line is ALWAYS present: these numbers are the only record of what
 * the distillation cost and of what it did NOT manage to do, and a compaction
 * whose distillation silently did nothing is the case that has to be visible.
 * The second line names every reason an oversized output stayed at full size
 * (the call cap, an orphan whose assistant is in the other slice, the prefill
 * budget); it is absent when none applies.
 */
export function formatDistillationReport(input: DistillationReportInput): string[] {
  const { window: windowPass, history: historyPass, budgetTotalTokens, callCap, numCtx } = input;
  const skipped = windowPass.skippedCount + historyPass.skippedCount;
  const orphans = windowPass.orphanCount + historyPass.orphanCount;
  const budgetStopped = windowPass.budgetSkippedCount + historyPass.budgetSkippedCount;
  const failed = windowPass.failedCount + historyPass.failedCount;
  const candidates = windowPass.candidateCount + historyPass.candidateCount;
  const distilled = windowPass.distilledCount + historyPass.distilledCount;
  const prefill = windowPass.prefillTokens + historyPass.prefillTokens;

  const lines = [
    `Tool distillation: distilled ${distilled} of ${candidates} oversized tool ` +
      `output(s) (~${prefill} tokens of prefill of a ${budgetTotalTokens}-token budget; ` +
      `${failed} call(s) failed and stay verbatim)`,
  ];

  if (skipped > 0 || orphans > 0 || budgetStopped > 0) {
    const parts: string[] = [];
    if (skipped > 0) {
      parts.push(
        `${skipped} oversized tool output(s) the call cap left verbatim ` +
          `(${windowPass.skippedCount} in the preserved window, ${historyPass.skippedCount} in the older history)`
      );
    }
    if (orphans > 0) {
      parts.push(
        `${orphans} oversized tool result(s) left verbatim because their assistant call is not in the same slice`
      );
    }
    if (budgetStopped > 0) {
      parts.push(
        `${budgetStopped} oversized tool output(s) left verbatim because the compaction's ` +
          `distillation prefill budget ran out`
      );
    }
    lines.push(
      `Tool distillation is capped at ${callCap} model call(s) for a ${numCtx}-token context — ` +
        `${parts.join('; ')}.`
    );
  }
  return lines;
}

/** The line after the preserved window was trimmed rather than the history re-summarised. */
export function formatTrimLine(
  trim: Pick<WindowTrimPlan, 'droppedCount' | 'droppedTokens'>,
  stillOverBudget: boolean,
  newTokenCount: number,
  acceptanceBudget: number
): string {
  return (
    `Dropped the ${trim.droppedCount} oldest preserved message(s) (~${trim.droppedTokens} tokens) ` +
    `to make room — the history was trimmed rather than re-summarised.${
      stillOverBudget
        ? ` Still ${newTokenCount} tokens against a ${acceptanceBudget}-token target.`
        : ''
    }`
  );
}

/** How the extra spend of the leftover distillation budget ended. */
export type ExtraDistillOutcome =
  | {
      /** The digests made the window smaller and were kept. */
      kind: 'kept';
      distilledCount: number;
      prefillTokens: number;
      stillOverBudget: boolean;
      newTokenCount: number;
      acceptanceBudget: number;
    }
  | {
      /** The digests were no smaller than the outputs they replace; the window is unchanged. */
      kind: 'rejected';
      distilledCount: number;
      prefillTokens: number;
    }
  | {
      /** Nothing left to spend on (`failedRows` of the candidates already failed once). */
      kind: 'nothing-left';
      leftoverBudgetTokens: number;
      failedRows: number;
    }
  | {
      /** The leftover budget cannot pay for even one call. */
      kind: 'unaffordable';
      leftoverBudgetTokens: number;
      candidateCount: number;
    }
  | {
      /** Every extra call failed. */
      kind: 'all-failed';
      attemptedCount: number;
      candidateCount: number;
    };

/** The one line that says what the leftover distillation budget bought. */
export function formatExtraDistillOutcome(outcome: ExtraDistillOutcome): string {
  switch (outcome.kind) {
    case 'kept': {
      return (
        `Spent the leftover distillation budget on ${outcome.distilledCount} more oversized tool ` +
        `output(s) of the preserved window (~${outcome.prefillTokens} tokens of prefill) — the ` +
        `compacted history is ${
          outcome.stillOverBudget
            ? `still over budget (${outcome.newTokenCount} tokens against a ${outcome.acceptanceBudget}-token budget)`
            : `now within budget (${outcome.newTokenCount} tokens against a ${outcome.acceptanceBudget}-token budget)`
        }.`
      );
    }
    case 'rejected': {
      return (
        `Spent the leftover distillation budget on ${outcome.distilledCount} more oversized tool ` +
        `output(s) of the preserved window (~${outcome.prefillTokens} tokens of prefill) — but the ` +
        `digests were no smaller than the outputs they replace, so the window is unchanged.`
      );
    }
    case 'nothing-left': {
      return outcome.failedRows > 0
        ? `No un-digested oversized tool output(s) left in the preserved window that the leftover ` +
            `distillation budget (~${outcome.leftoverBudgetTokens} tokens) may spend on — the only oversized ` +
            `output(s) left are ${outcome.failedRows} whose distillation call(s) failed, and a failure is not ` +
            `retried here.`
        : `No un-digested oversized tool output(s) left in the preserved window — the leftover ` +
            `distillation budget (~${outcome.leftoverBudgetTokens} tokens) has nothing to spend on.`;
    }
    case 'unaffordable': {
      return (
        `The leftover distillation budget (~${outcome.leftoverBudgetTokens} tokens) cannot pay for another ` +
        `distillation call — ${outcome.candidateCount} un-digested oversized tool output(s) stay ` +
        `verbatim in the preserved window.`
      );
    }
    case 'all-failed': {
      return (
        `All ${outcome.attemptedCount} extra distillation call(s) failed — ${outcome.candidateCount} ` +
        `un-digested oversized tool output(s) stay verbatim in the preserved window.`
      );
    }
  }
}

/** The line before the retry with a stronger compression factor. */
export function formatRetryLine(
  newTokenCount: number,
  numCtx: number,
  retryFactor: number,
  remainingRetries: number
): string {
  return (
    `Compacted to ${newTokenCount} tokens but limit is ${numCtx} — ` +
    `retrying with ${retryFactor.toFixed(1)}x stronger compression (${remainingRetries} attempt(s) left)...`
  );
}

/**
 * The line that says the recent-files stub is in the returned history. It is
 * only ever produced AFTER the stub is in the array that is returned, so the
 * claim and the result cannot disagree.
 */
export function formatStubLine(
  plan: Pick<RecentFilesPlan, 'dropped' | 'included' | 'tokensUsed'>
): string {
  const included = plan.included.length;
  const filesSubject = included === 1 ? 'file' : 'files';
  return `Re-attached the ${included} most recently touched ${filesSubject} ${describeRecentFilesShape(plan.dropped)} (~${plan.tokensUsed} tokens).`;
}

/** Everything the `compaction_size` diagnostic reports about one pass. */
export interface SizeDiagnosticInput {
  numCtx: number;
  acceptanceBudget: number;
  oldTokenCount: number;
  /** The local estimate of the result (the number the UI shows). */
  estimatedNewTokens: number;
  systemPromptTokens: number;
  /** The live measurement, when the estimate landed inside the confirm band. */
  confirmedNewTokens?: number | undefined;
  recentFiles?: Pick<RecentFilesPlan, 'dropped' | 'included' | 'tokensUsed'> | undefined;
  trim?: Pick<WindowTrimPlan, 'droppedCount' | 'droppedTokens' | 'stopReason'> | undefined;
  extraDistill?: { distilledCount: number; prefillTokens: number } | undefined;
  /** True when this pass re-entered the compaction with a stronger factor. */
  retried: boolean;
  /** This pass's own verdict: still over budget after everything it tried. */
  retry: boolean;
}

/**
 * The `compaction_size` diagnostic.
 *
 * WHICH method decided the retry is a diagnostic, not a stat: `CompactStats` is
 * what the UI shows and it must stay reproducible from the stored history. A
 * section that did not happen is ABSENT (never `undefined`): to a reader of the
 * log, and to a test with `toStrictEqual`, a missing key and an `undefined` key
 * are different things.
 */
export function buildSizeDiagnostic(input: SizeDiagnosticInput): DiagnosticTraceEntry {
  return {
    layer: 'compact',
    phase: 'compaction_size',
    method: input.confirmedNewTokens === undefined ? 'local-estimate' : 'live-confirmed',
    numCtx: input.numCtx,
    acceptanceBudget: input.acceptanceBudget,
    oldTokenCount: input.oldTokenCount,
    estimatedNewTokens: input.estimatedNewTokens,
    systemPromptTokens: input.systemPromptTokens,
    ...(input.confirmedNewTokens === undefined
      ? {}
      : { confirmedNewTokens: input.confirmedNewTokens }),
    ...(input.recentFiles === undefined
      ? {}
      : {
          recentFiles: {
            included: input.recentFiles.included.length,
            tokens: input.recentFiles.tokensUsed,
            dropped: input.recentFiles.dropped,
          },
        }),
    ...(input.trim === undefined
      ? {}
      : {
          windowTrim: {
            droppedCount: input.trim.droppedCount,
            droppedTokens: input.trim.droppedTokens,
            stopReason: input.trim.stopReason,
          },
        }),
    ...(input.extraDistill === undefined
      ? {}
      : {
          extraDistill: {
            distilledCount: input.extraDistill.distilledCount,
            prefillTokens: input.extraDistill.prefillTokens,
          },
        }),
    retried: input.retried,
    retry: input.retry,
  };
}
