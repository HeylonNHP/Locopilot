/**
 * The words of a compaction: the progress lines and the `compaction_size`
 * diagnostic (src/services/compact/progressText.ts).
 *
 * WHY literal strings: these lines reach the UI, and the diagnostic is read from
 * the log. Every expected string below is written out by hand from the text the
 * pass printed BEFORE it moved out of `orchestrate.ts`, so the builders are
 * compared with the original wording and not with themselves. The end-to-end
 * transcripts in `compact-orchestrate.test.mjs` pin the same lines in context.
 *
 * No network, no model.
 */

import { describe, expect, test } from '@jest/globals';

import {
  buildSizeDiagnostic,
  formatDistillationReport,
  formatExtraDistillOutcome,
  formatPreparingLine,
  formatRetryLine,
  formatStubLine,
  formatTrimLine,
} from '../src/services/compact/progressText.ts';

/** A `DistillResult` with only the counters a report reads. */
const pass = (overrides = {}) => ({
  distilledCount: 0,
  skippedCount: 0,
  orphanCount: 0,
  failedCount: 0,
  budgetSkippedCount: 0,
  candidateCount: 0,
  prefillTokens: 0,
  ...overrides,
});

describe('the first line', () => {
  test('names how the history was split', () => {
    expect(formatPreparingLine(11, 3)).toBe(
      'Preparing compaction: summarizing 11 messages, preserving 3 recent messages'
    );
  });
});

describe('the distillation report', () => {
  test('is one line when nothing stayed verbatim', () => {
    expect(
      formatDistillationReport({
        window: pass({ distilledCount: 2, candidateCount: 2, prefillTokens: 1252 }),
        history: pass(),
        budgetTotalTokens: 4096,
        callCap: 2,
        numCtx: 4096,
      })
    ).toStrictEqual([
      'Tool distillation: distilled 2 of 2 oversized tool output(s) (~1252 tokens of prefill of a 4096-token budget; 0 call(s) failed and stay verbatim)',
    ]);
  });

  test('adds the line that says why something stayed verbatim, naming every reason', () => {
    expect(
      formatDistillationReport({
        window: pass({
          distilledCount: 2,
          candidateCount: 6,
          prefillTokens: 3778,
          skippedCount: 2,
          orphanCount: 1,
          failedCount: 1,
        }),
        history: pass({ skippedCount: 1, budgetSkippedCount: 3, candidateCount: 4 }),
        budgetTotalTokens: 4096,
        callCap: 2,
        numCtx: 4096,
      })
    ).toStrictEqual([
      'Tool distillation: distilled 2 of 10 oversized tool output(s) (~3778 tokens of prefill of a 4096-token budget; 1 call(s) failed and stay verbatim)',
      "Tool distillation is capped at 2 model call(s) for a 4096-token context — 3 oversized tool output(s) the call cap left verbatim (2 in the preserved window, 1 in the older history); 1 oversized tool result(s) left verbatim because their assistant call is not in the same slice; 3 oversized tool output(s) left verbatim because the compaction's distillation prefill budget ran out.",
    ]);
  });

  test('names only the reasons that apply', () => {
    const lines = formatDistillationReport({
      window: pass({ budgetSkippedCount: 2, candidateCount: 2 }),
      history: pass(),
      budgetTotalTokens: 4096,
      callCap: 2,
      numCtx: 4096,
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "Tool distillation is capped at 2 model call(s) for a 4096-token context — 2 oversized tool output(s) left verbatim because the compaction's distillation prefill budget ran out."
    );
  });
});

describe('the trim line', () => {
  const trim = { droppedCount: 1, droppedTokens: 190 };

  test('says the history was trimmed, not re-summarised', () => {
    expect(formatTrimLine(trim, false, 3524, 3686)).toBe(
      'Dropped the 1 oldest preserved message(s) (~190 tokens) to make room — the history was trimmed rather than re-summarised.'
    );
  });

  test('adds how far over the target it still is', () => {
    expect(formatTrimLine(trim, true, 4086, 3686)).toBe(
      'Dropped the 1 oldest preserved message(s) (~190 tokens) to make room — the history was trimmed rather than re-summarised. Still 4086 tokens against a 3686-token target.'
    );
  });
});

describe('the extra distillation spend', () => {
  test.each([
    [
      'kept, within budget',
      {
        kind: 'kept',
        distilledCount: 2,
        prefillTokens: 1252,
        stillOverBudget: false,
        newTokenCount: 3493,
        acceptanceBudget: 3686,
      },
      'Spent the leftover distillation budget on 2 more oversized tool output(s) of the preserved window (~1252 tokens of prefill) — the compacted history is now within budget (3493 tokens against a 3686-token budget).',
    ],
    [
      'kept, still over',
      {
        kind: 'kept',
        distilledCount: 2,
        prefillTokens: 1252,
        stillOverBudget: true,
        newTokenCount: 4287,
        acceptanceBudget: 3686,
      },
      'Spent the leftover distillation budget on 2 more oversized tool output(s) of the preserved window (~1252 tokens of prefill) — the compacted history is still over budget (4287 tokens against a 3686-token budget).',
    ],
    [
      'rejected',
      { kind: 'rejected', distilledCount: 2, prefillTokens: 1252 },
      'Spent the leftover distillation budget on 2 more oversized tool output(s) of the preserved window (~1252 tokens of prefill) — but the digests were no smaller than the outputs they replace, so the window is unchanged.',
    ],
    [
      'nothing left',
      { kind: 'nothing-left', leftoverBudgetTokens: 4096, failedRows: 0 },
      'No un-digested oversized tool output(s) left in the preserved window — the leftover distillation budget (~4096 tokens) has nothing to spend on.',
    ],
    [
      'nothing left but failures',
      { kind: 'nothing-left', leftoverBudgetTokens: 2800, failedRows: 2 },
      'No un-digested oversized tool output(s) left in the preserved window that the leftover distillation budget (~2800 tokens) may spend on — the only oversized output(s) left are 2 whose distillation call(s) failed, and a failure is not retried here.',
    ],
    [
      'unaffordable',
      { kind: 'unaffordable', leftoverBudgetTokens: 318, candidateCount: 2 },
      'The leftover distillation budget (~318 tokens) cannot pay for another distillation call — 2 un-digested oversized tool output(s) stay verbatim in the preserved window.',
    ],
    [
      'all failed',
      { kind: 'all-failed', attemptedCount: 2, candidateCount: 2 },
      'All 2 extra distillation call(s) failed — 2 un-digested oversized tool output(s) stay verbatim in the preserved window.',
    ],
  ])('%s', (_label, outcome, expected) => {
    expect(formatExtraDistillOutcome(outcome)).toBe(expected);
  });
});

describe('the retry line', () => {
  test.each([
    [
      4086,
      4096,
      1.5,
      2,
      'Compacted to 4086 tokens but limit is 4096 — retrying with 1.5x stronger compression (2 attempt(s) left)...',
    ],
    [
      7229,
      4096,
      2.353_515_6,
      2,
      'Compacted to 7229 tokens but limit is 4096 — retrying with 2.4x stronger compression (2 attempt(s) left)...',
    ],
    [
      3909,
      4096,
      1.5,
      1,
      'Compacted to 3909 tokens but limit is 4096 — retrying with 1.5x stronger compression (1 attempt(s) left)...',
    ],
  ])('%p of %p at factor %p with %p left', (tokens, numCtx, factor, left, expected) => {
    expect(formatRetryLine(tokens, numCtx, factor, left)).toBe(expected);
  });
});

describe('the stub line', () => {
  test.each([
    [
      ['a.ts'],
      'none',
      120,
      'Re-attached the 1 most recently touched file with whole-file excerpts (~120 tokens).',
    ],
    [
      ['a.ts', 'b.ts'],
      'none',
      245,
      'Re-attached the 2 most recently touched files with whole-file excerpts (~245 tokens).',
    ],
    [
      ['a.ts', 'b.ts'],
      'unreadable',
      60,
      'Re-attached the 2 most recently touched files as paths only (none could be read) (~60 tokens).',
    ],
    [
      ['a.ts'],
      'oversize',
      40,
      'Re-attached the 1 most recently touched file as paths only (too large to include whole) (~40 tokens).',
    ],
    [
      ['a.ts'],
      'in-context',
      40,
      'Re-attached the 1 most recently touched file as paths only (already in the preserved window) (~40 tokens).',
    ],
    [
      ['a.ts', 'b.ts', 'c.ts'],
      'no-budget',
      90,
      'Re-attached the 3 most recently touched files as paths only (no room for excerpts) (~90 tokens).',
    ],
  ])('%j (%s)', (included, dropped, tokensUsed, expected) => {
    expect(formatStubLine({ included, dropped, tokensUsed })).toBe(expected);
  });
});

describe('the compaction_size diagnostic', () => {
  const minimal = {
    numCtx: 4096,
    acceptanceBudget: 3686,
    oldTokenCount: 4571,
    estimatedNewTokens: 656,
    systemPromptTokens: 11,
    retried: false,
    retry: false,
  };

  test('a pass that did nothing special carries no optional section', () => {
    // toStrictEqual: a key that is present with the value `undefined` is NOT the same as an absent key.
    expect(buildSizeDiagnostic(minimal)).toStrictEqual({
      layer: 'compact',
      phase: 'compaction_size',
      method: 'local-estimate',
      numCtx: 4096,
      acceptanceBudget: 3686,
      oldTokenCount: 4571,
      estimatedNewTokens: 656,
      systemPromptTokens: 11,
      retried: false,
      retry: false,
    });
  });

  test('an undefined section is absent, not undefined', () => {
    const entry = buildSizeDiagnostic({
      ...minimal,
      confirmedNewTokens: undefined,
      recentFiles: undefined,
      trim: undefined,
      extraDistill: undefined,
    });
    expect(Object.keys(entry).sort()).toStrictEqual(
      [
        'acceptanceBudget',
        'layer',
        'method',
        'numCtx',
        'oldTokenCount',
        'phase',
        'retried',
        'retry',
        'estimatedNewTokens',
        'systemPromptTokens',
      ].sort()
    );
  });

  test('every section that happened is reported, in its own shape', () => {
    expect(
      buildSizeDiagnostic({
        ...minimal,
        confirmedNewTokens: 3012,
        recentFiles: { included: ['a.ts', 'b.ts'], tokensUsed: 245, dropped: 'none' },
        trim: { droppedCount: 1, droppedTokens: 190, stopReason: 'trimmed-insufficient' },
        extraDistill: { distilledCount: 2, prefillTokens: 1252 },
        retried: true,
        retry: true,
      })
    ).toStrictEqual({
      layer: 'compact',
      phase: 'compaction_size',
      method: 'live-confirmed',
      numCtx: 4096,
      acceptanceBudget: 3686,
      oldTokenCount: 4571,
      estimatedNewTokens: 656,
      systemPromptTokens: 11,
      confirmedNewTokens: 3012,
      recentFiles: { included: 2, tokens: 245, dropped: 'none' },
      windowTrim: { droppedCount: 1, droppedTokens: 190, stopReason: 'trimmed-insufficient' },
      extraDistill: { distilledCount: 2, prefillTokens: 1252 },
      retried: true,
      retry: true,
    });
  });
});
