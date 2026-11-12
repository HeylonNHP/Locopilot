/**
 * The phases a compaction runs after it has a result (src/services/compact/phases.ts):
 * the confirm measurement, the trim, the leftover distillation spend, the skip
 * set the spend builds, and the stub's attach.
 *
 * Each phase is driven here with a hand-made pass environment and a hand-made
 * result, so the boundary cases are legible in one line: a count exactly on the
 * boundary, a window with nothing droppable, digests longer than the outputs they
 * replace. `compact-orchestrate.test.mjs` pins the same behaviour end to end.
 *
 * No network, no model: the measure and the extra digest are the only calls, and
 * the extra digest is exercised against a fake provider.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { createPassEnv, draftResult, FIRST_ATTEMPT } from '../src/services/compact/pass.ts';
import {
  attachRecentFilesStub,
  confirmVerdict,
  planHandledWindowRows,
  positionsOf,
  spendLeftoverDistillBudget,
  trimPreservedWindow,
  windowPositionsBySource,
} from '../src/services/compact/phases.ts';
import { attachRecentFilesMessage } from '../src/services/compact/recentFiles.ts';
import { enterScratchCwd } from './helpers/fakeOllama.mjs';

const MODEL = 'gpt-4o';
const ctx = { providerId: 'ollama', baseUrl: 'http://127.0.0.1:1' };

const user = (text) => ({ role: 'user', content: text });
const assistant = (text) => ({ role: 'assistant', content: text });

/** Varied prose, so the tokenizer counts real words (about 11 tokens a line). */
const lines = (label, count) =>
  Array.from(
    { length: count },
    (_, index) => `${label} line ${index}: value=${(index * 7919) % 1009} token-${index}`
  ).join('\n');

/** A pass over a 1000-token window: the boundary is 900. */
function pass(numCtx = 1000, messages = [user('go')]) {
  return createPassEnv({ ctx, model: MODEL, numCtx }, messages, FIRST_ATTEMPT);
}

/** What the progress lines of a phase said. */
function recordProgress(env) {
  const lines = [];
  env.request.onProgress = (line) => lines.push(line);
  return lines;
}

describe('the confirm verdict', () => {
  test('passes the estimate’s verdict through when it is not in the band', async () => {
    const env = pass();
    const draft = draftResult(env, assistant('summary'), [user('kept')], [0]);
    // No `confirm`: the live count is never paid for.
    const outcome = await confirmVerdict(env, draft, { retry: true, confirm: false });
    expect(outcome.overBudget).toBe(true);
    expect(outcome.confirmedTokens).toBeUndefined();
    expect(outcome.draft).toBe(draft);
  });

  test('a live count inside the band replaces the estimate’s answer', async () => {
    const env = pass();
    const draft = draftResult(env, assistant('summary'), [user('kept')], [0]);
    // `measure.ts` is the real one: the fake baseUrl cannot answer, so the
    // measurement falls back to its local estimate. What matters here is the
    // SHAPE — a confirmation is paid for exactly when the band says so.
    const outcome = await confirmVerdict(env, draft, { retry: false, confirm: true });
    expect(typeof outcome.confirmedTokens).toBe('number');
    expect(outcome.overBudget).toBe(outcome.confirmedTokens > env.acceptanceBudget);
    // The draft is unchanged: the live figure decides, the STAT stays the estimate.
    expect(outcome.draft).toBe(draft);
  });
});

describe('the trim phase', () => {
  /** Enough preserved turns that the planner has something to drop. */
  const window = () => Array.from({ length: 8 }, (_, index) => user(lines(`w${index}`, 6)));

  test('drops the oldest messages and re-takes the verdict', () => {
    const env = pass(1000);
    const summary = assistant(lines('summary', 40));
    const preserved = window();
    const draft = draftResult(env, summary, preserved, preserved.map((_, index) => index));
    const outcome = trimPreservedWindow(env, draft);
    expect(outcome).toBeDefined();
    expect(outcome.trim.droppedCount).toBeGreaterThan(0);
    expect(outcome.trim.keptIndices).toStrictEqual(
      outcome.trim.messages.map((_, index) =>
        preserved.indexOf(outcome.draft.window[index])
      )
    );
    // The summary gains the notice, and the count belongs to the new array.
    expect(outcome.draft.summary.content).toContain(
      `[Note: ${outcome.trim.droppedCount} earlier messages were dropped`
    );
    expect(outcome.overBudget).toBe(draft.overBudget && outcome.draft.tokens > env.acceptanceBudget);
  });

  test('nothing droppable means no trim, and no change', () => {
    const env = pass(1000);
    const draft = draftResult(env, assistant(lines('summary', 80)), [user('one turn')], [0]);
    // One preserved turn with no room: the planner may not drop it (it is the
    // last message), so the phase has nothing to say.
    expect(trimPreservedWindow(env, draft)).toBeUndefined();
  });

  test('the trim is silent when it dropped nothing', () => {
    const env = pass(1_000_000);
    const progress = recordProgress(env);
    const preserved = window();
    const draft = draftResult(env, assistant('summary'), preserved, preserved.map((_, i) => i));
    expect(trimPreservedWindow(env, draft)).toBeUndefined();
    expect(progress).toStrictEqual([]);
  });
});

describe('the skip set the extra spend builds', () => {
  test('maps original indices into the post-trim window, dropping the removed ones', () => {
    // The trimmer kept original rows 3, 5 and 7 (the anchor was hoisted to the
    // front, so the kept rows are no longer in ascending order at their new
    // positions).
    const env = pass();
    const window = [
      { role: 'user', content: 'the anchor, hoisted from row 7' },
      { role: 'user', content: 'row 3' },
      { role: 'user', content: 'row 5' },
    ];
    const draft = draftResult(env, assistant('summary'), window, [7, 3, 5]);
    expect([...windowPositionsBySource(draft).entries()]).toStrictEqual([
      [7, 0],
      [3, 1],
      [5, 2],
    ]);
    // Digests at original rows 3 and 5, a failure at 7: all three are now at
    // positions 1, 2 and 0 — and row 4, which the trim removed, is not anywhere.
    const { handledRows, failedRows } = planHandledWindowRows(draft, {
      distilledIndices: [3, 5, 4],
      failedIndices: [7, 6],
    });
    expect([...failedRows].sort()).toStrictEqual([0]);
    expect([...handledRows].sort()).toStrictEqual([0, 1, 2]);
    expect([...positionsOf([4, 6], windowPositionsBySource(draft))]).toStrictEqual([]);
  });
});

describe('the leftover distillation spend', () => {
  let scratch;

  beforeAll(() => {
    scratch = enterScratchCwd('locopilot-phases');
  });

  afterAll(() => {
    scratch?.leave();
  });

  /** The window every spend test starts from: two outputs of `count` lines each. */
  const windowWithOutputs = (count) => {
    const outs = Array.from({ length: 2 }, (_, index) => ({
      role: 'tool',
      content: lines(`out${index}`, count),
      tool_call_id: `c${index}`,
    }));
    return [
      user('run the checks'),
      {
        role: 'assistant',
        content: '',
        tool_calls: outs.map((_, index) => ({
          id: `c${index}`,
          type: 'function',
          function: { name: 'run_command', arguments: '{}' },
        })),
      },
      ...outs,
    ];
  };

  /**
   * Run one spend against a fake provider: the pass is built on the fake's base
   * URL, so the digest calls reach it.
   */
  async function spend({ respond, window, skipped = { distilledIndices: [], failedIndices: [] } }) {
    const { runScenario } = await import('./helpers/compactionHarness.mjs');
    const { TOOL_DISTILL_SYSTEM_PROMPT } = await import('../src/services/compact/constants.ts');
    const progress = [];
    let env;
    let draft;
    const result = await runScenario({
      distillSystemPrompt: TOOL_DISTILL_SYSTEM_PROMPT,
      respond,
      run: (fakeCtx) => {
        env = createPassEnv(
          { ctx: fakeCtx, model: MODEL, numCtx: 32_768 },
          [user('go')],
          FIRST_ATTEMPT
        );
        draft = draftResult(env, assistant('summary'), window, window.map((_, index) => index));
        env.request.onProgress = (line) => progress.push(line);
        return spendLeftoverDistillBudget(env, draft, skipped);
      },
    });
    expect(result.error).toBeUndefined();
    return { outcome: result.value, env, draft, progress };
  }

  test('keeps digests that made the result smaller and re-takes the verdict', async () => {
    const { outcome, env, draft, progress } = await spend({
      window: windowWithOutputs(160),
      respond: () => ({ text: 'DIGEST' }),
    });
    expect(outcome.extraDistill.distilledCount).toBe(2);
    expect(outcome.extraDistill.prefillTokens).toBeGreaterThan(0);
    // The digests are in the draft, the count is smaller and the budget is charged.
    expect(outcome.draft.tokens).toBeLessThan(draft.tokens);
    expect(outcome.overBudget).toBe(outcome.draft.tokens > env.acceptanceBudget);
    expect(env.distillBudget.usedTokens).toBe(outcome.extraDistill.prefillTokens);
    expect(progress.at(-1)).toMatch(/^Spent the leftover distillation budget on 2 more/);
  });

  test('digests that are not smaller leave the draft as it was', async () => {
    // A digest longer than the output it replaces, but under the distiller's own
    // output cap — a CUT digest would be short again, and this test needs the
    // model's answer to survive intact to be rejected on size.
    const { outcome, env, draft, progress } = await spend({
      // Each output is ~1800 characters (over the distiller's 1200-character
      // threshold, so it is planned for distillation); the digest is ~3000,
      // longer than what it replaces and under the ~3584-character output cap.
      window: windowWithOutputs(60),
      respond: () => ({ text: lines('digest', 70) }),
    });
    expect(outcome.extraDistill.distilledCount).toBe(2);
    // Bigger or not, the draft is the one that was passed in.
    expect(outcome.draft).toBe(draft);
    // The calls were still paid for: the budget bounds the prefill, not success.
    expect(env.distillBudget.usedTokens).toBe(outcome.extraDistill.prefillTokens);
    expect(progress.at(-1)).toMatch(/but the digests were no smaller/);
  });

  test('nothing to spend on says so with the failures it skipped', async () => {
    const { outcome, draft, progress } = await spend({
      window: windowWithOutputs(160),
      respond: () => ({ text: 'DIGEST' }),
      // Every oversized row was already dealt with: the two tool rows are at
      // indices 2 and 3, and one of them failed.
      skipped: { distilledIndices: [2], failedIndices: [3] },
    });
    expect(outcome.draft).toBe(draft);
    expect(progress.at(-1)).toMatch(/^No un-digested oversized tool output\(s\) left/);
    // The failure the phase skipped is named in the line, not silently dropped.
    expect(progress.at(-1)).toMatch(/1 un-digested|failed/);
  });
});

describe('the stub’s attach', () => {
  const plan = {
    text: 'the body of the stub',
    tokensUsed: 50,
    included: ['/work/a.ts'],
    dropped: 'none',
  };

  test('is attached directly after the summary when it fits', async () => {
    const env = pass(100_000);
    // A history big enough that the finished result is still smaller than it.
    const draft = draftResult(env, assistant('summary'), [user('kept')], [0]);
    const roomy = { ...env, oldTokenCount: draft.tokens + 10_000 };
    const attached = await attachRecentFilesStub(roomy, draft, plan);
    expect(attached).toBeDefined();
    expect(attached.draft.messages[1].content).toBe(plan.text);
    expect(attached.draft.messages).toHaveLength(3);
    expect(attached.draft.tokens).toBeGreaterThan(draft.tokens);
    expect(attached.draft.overBudget).toBe(attached.draft.tokens > roomy.acceptanceBudget);
    expect(attached.plan).toBe(plan);
  });

  test('a stub that would un-shrink the history is refused, and nothing is claimed', async () => {
    const env = pass(1_000_000);
    const draft = draftResult(env, assistant('summary'), [user('kept')], [0]);
    // The old count is below the finished result: attaching would make the
    // result no smaller than the history it replaces.
    const tooSmall = { ...env, oldTokenCount: draft.tokens };
    expect(await attachRecentFilesStub(tooSmall, draft, plan)).toBeUndefined();
    // And the attach agrees with the function it delegates to.
    expect(
      attachRecentFilesMessage({
        messages: draft.messages,
        message: { role: 'assistant', content: plan.text },
        model: MODEL,
        systemPromptTokens: env.systemPromptTokens,
        oldTokenCount: draft.tokens,
        acceptanceBudget: env.acceptanceBudget,
      })
    ).toBeNull();
  });

  test('a stub that would push the result past the boundary is refused', async () => {
    const env = pass(1_000);
    const summary = assistant(lines('summary', 40));
    const draft = draftResult(env, summary, [user('kept')], [0]);
    // The result itself is inside the boundary; the stub would take it over.
    expect(draft.overBudget).toBe(false);
    const huge = { ...plan, text: lines('stub', 200) };
    const attached = await attachRecentFilesStub(
      { ...env, acceptanceBudget: draft.tokens + 1 },
      draft,
      huge
    );
    expect(attached).toBeUndefined();
  });
});
