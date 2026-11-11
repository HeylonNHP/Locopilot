/**
 * Tests for the preserved-window trimmer.
 *
 * No network, no model call — every check exercises the pure planner in
 * `src/services/compact/windowTrim.ts` and the local tokenizer.
 *
 * WHY these tests exist: the trimmer replaces the recursive "compact the
 * already-compacted array" retry with "drop the oldest preserved messages",
 * which is only safe if the plan keeps a small set of promises. Each check
 * below pins one of them:
 *
 * 1. SUBSEQUENCE — the plan never invents, duplicates or reorders messages,
 *    except for the single hoisted anchor.
 * 2. THE ANCHOR SURVIVES — the latest real user message is present at EVERY
 *    budget, including zero, and appears exactly once.
 * 3. NO ORPHAN HEAD — a trimmed plan never starts with a `tool` row, whose
 *    owning assistant the cut just removed.
 * 4. THE LAST MESSAGE SURVIVES — it is the turn in flight.
 * 5. NO FALSE TRIM — `droppedCount === 0` iff the stop reason says nothing was
 *    droppable, so the caller never appends a notice describing nothing.
 * 6. MONOTONICITY — a smaller budget never returns a longer window.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatWindowTrimNotice,
  RECENT_FILES_MIN_TOKENS,
  SUMMARY_PREAMBLE,
} from '../src/services/compact/constants.ts';
import {
  attachRecentFilesMessage,
  buildRecentFilesMessage,
  computeBudgetForResult,
} from '../src/services/compact/recentFiles.ts';
import {
  computePreservedWindowBudget,
  planWindowTrim,
} from '../src/services/compact/windowTrim.ts';
import {
  countMessagesTokens,
  countMessageTokens,
  countTextTokens,
} from '../src/services/tokenizer.ts';
import { withContext } from './helpers/withContext.mjs';

const MODEL = 'gpt-4o';
/** A fixed "now" so the stub's ages are exact. */
const NOW = 1_700_000_000_000;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * One `session_recent_files` row, as the loader returns it.
 *
 * @param {string} filePath - the absolute path.
 * @returns {object} the row.
 */
function recentFileRow(filePath) {
  return { path: filePath, tool: 'patch_file', hits: 2, lastSeenAt: NOW - 120_000 };
}

/**
 * Builds a message whose content has a predictable size.
 *
 * @param {'system'|'user'|'assistant'|'tool'} role - the role.
 * @param {number} chars - how many characters of filler to carry.
 * @param {object} [extra] - extra fields (e.g. `tool_call_id`, `tool_calls`).
 * @returns {object} the message.
 */
function message(role, chars, extra = {}) {
  return { role, content: 'x'.repeat(chars), ...extra };
}

/**
 * A tool result plus the assistant row that issued it, so the pair is a legal
 * block and the trimmer can drop it as a unit.
 *
 * @param {number} chars - the size of the tool output.
 * @param {string} id - the tool-call id.
 * @returns {object[]} the two messages.
 */
function toolBlock(chars, id) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    message('tool', chars, { tool_call_id: id }),
  ];
}

const tokensOf = (messages) => countMessagesTokens(messages, MODEL);
/** The tokens a single message contributes, WITHOUT the per-array overhead. */
const tokensOfOne = (entry) => countMessageTokens(entry, MODEL);

/**
 * Asserts the invariants that must hold for EVERY plan.
 *
 * @param {object[]} preserved - the input window.
 * @param {object} plan - the planner's answer.
 * @param {string} label - where the failure happened.
 */
function assertPlanInvariants(preserved, plan, label) {
  withContext(label, () => {
    // 4: the last message is never dropped.
    if (preserved.length > 0) {
      expect(plan.messages.at(-1)).toBe(preserved.at(-1));
    }
    // 5: no false trim.
    if (plan.droppedCount === 0) {
      expect(
        plan.stopReason === 'already-fits' || plan.stopReason === 'nothing-droppable'
      ).toBeTruthy();
    } else {
      expect(
        plan.stopReason === 'trimmed' || plan.stopReason === 'trimmed-insufficient'
      ).toBeTruthy();
      // 3: no orphan head.
      expect(plan.messages[0]?.role).not.toBe('tool');
      expect(plan.messages.length).toBeGreaterThan(0);
    }
    // 1: subsequence plus at most one hoisted anchor.
    let previous = -1;
    let hoists = 0;
    const usedIndices = new Set();
    plan.messages.forEach((entry, position) => {
      const found = preserved.indexOf(entry);
      expect(found).not.toBe(-1);
      expect(usedIndices.has(found)).toBeFalsy();
      usedIndices.add(found);
      if (found <= previous) {
        expect(position).toBe(0);
        hoists += 1;
        expect(hoists).toBe(1);
      }
      previous = found;
    });
    // 7: the kept indexes point back at the input window.
    expect(plan.keptIndices.length).toBe(plan.messages.length);
    plan.messages.forEach((entry, position) => {
      expect(plan.keptIndices[position]).toBe(preserved.indexOf(entry));
    });
  });
}

describe('the window trimmer leaves a window that already fits alone', () => {
  test('an empty window is already-fits', () => {
    const plan = planWindowTrim([], 1000, MODEL);
    expect(plan.droppedCount).toBe(0);
    expect(plan.stopReason).toBe('already-fits');
    expect(plan.messages).toStrictEqual([]);
  });

  test('a window that fits is returned by reference, untouched', () => {
    const preserved = [message('user', 400), message('assistant', 800), message('user', 200)];
    const plan = planWindowTrim(preserved, tokensOf(preserved), MODEL);
    expect(plan.messages).toBe(preserved);
    expect(plan.droppedCount).toBe(0);
    expect(plan.droppedTokens).toBe(0);
    expect(plan.stopReason).toBe('already-fits');
  });

  test('a single-message window drops nothing even at a zero budget', () => {
    const preserved = [message('user', 4000)];
    for (const budget of [0, -500, tokensOf(preserved) - 1]) {
      const plan = planWindowTrim(preserved, budget, MODEL);
      expect(plan.droppedCount).toBe(0);
      expect(plan.messages).toBe(preserved);
      expect(plan.stopReason).toBe('nothing-droppable');
    }
  });
});

describe('the window trimmer drops the oldest messages first', () => {
  test('exactly one message is dropped when the budget affords one', () => {
    const preserved = [
      message('assistant', 200),
      message('user', 300),
      message('assistant', 800),
      message('user', 200),
      message('assistant', 900),
    ];
    const total = tokensOf(preserved);
    const first = tokensOfOne(preserved[0]);
    const plan = planWindowTrim(preserved, total - first, MODEL);
    expect(plan.droppedCount).toBe(1);
    expect(plan.messages[0]).toBe(preserved[1]);
    expect(plan.messages).toHaveLength(preserved.length - 1);
    expect(plan.droppedTokens).toBe(tokensOfOne(preserved[0]));
    expect(plan.stopReason).toBe('trimmed');
    assertPlanInvariants(preserved, plan, 'one message');
  });

  test('a tool block is dropped as a unit, never leaving an orphan head', () => {
    const [assistant, tool] = toolBlock(3000, 'call-1');
    const preserved = [assistant, tool, message('assistant', 400), message('user', 200)];
    const plan = planWindowTrim(
      preserved,
      tokensOf(preserved) - tokensOfOne(assistant) - tokensOfOne(tool),
      MODEL
    );
    expect(plan.droppedCount).toBe(2);
    expect(plan.messages[0]).toBe(preserved[2]);
    expect(plan.messages[0].role).not.toBe('tool');
    assertPlanInvariants(preserved, plan, 'tool block');
  });

  test('the anchor is hoisted to the front when the cut would pass it', () => {
    // The latest user message sits mid-window and MOST of the window has to go:
    // without the hoist nothing would be droppable, because the cut cannot be
    // taken past the anchor.
    const anchor = message('user', 200);
    const last = message('assistant', 2500);
    const preserved = [
      message('assistant', 200),
      message('user', 2600),
      message('assistant', 1800),
      anchor,
      message('assistant', 2600),
      last,
    ];
    const plan = planWindowTrim(preserved, tokensOf([anchor, last]), MODEL);
    expect(plan.droppedCount).toBeGreaterThan(0);
    expect(plan.messages[0]).toBe(anchor);
    expect(plan.messages.filter((entry) => entry === anchor)).toHaveLength(1);
    expect(plan.messages).toStrictEqual([anchor, last]);
    expect(plan.droppedCount).toBe(4);
    expect(plan.stopReason).toBe('trimmed');
    assertPlanInvariants(preserved, plan, 'hoisted anchor');
  });

  test('a synthetic nudge is never mistaken for the anchor', () => {
    // The window ends with a server-generated nudge. If the trimmer latched onto
    // that instead of the real prompt, the real prompt would be dropped at a
    // zero budget.
    const realPrompt = message('user', 1200);
    const preserved = [
      realPrompt,
      message('assistant', 600),
      {
        role: 'user',
        content: '[System notice: please continue working on the task. [End system notice]',
      },
    ];
    const plan = planWindowTrim(preserved, 0, MODEL);
    expect(plan.messages).toContain(realPrompt);
    expect(plan.messages[0]).toBe(realPrompt);
    assertPlanInvariants(preserved, plan, 'synthetic nudge');
  });

  test('a window whose only user row is a nudge keeps that nudge', () => {
    // The fallback: `findLatestUserMessageIndex` skips synthetic nudges, so a
    // nudge-only window returned -1 and the trim dropped EVERY user-role row,
    // leaving `[assistant]` — a window with no request in it, which the model
    // cannot act on. The nudge is not a real prompt, but it is the only anchor
    // the window has.
    const nudge = {
      role: 'user',
      content: '[System notice: please continue working on the task. [End system notice]',
    };
    const first = message('assistant', 2000);
    const last = message('assistant', 2000);
    const preserved = [nudge, first, last];
    const plan = planWindowTrim(preserved, 0, MODEL);
    expect(plan.droppedCount).toBeGreaterThan(0);
    expect(plan.messages).toContain(nudge);
    expect(plan.messages[0]).toBe(nudge);
    expect(plan.messages.filter((entry) => entry === nudge)).toHaveLength(1);
    expect(plan.messages.at(-1)).toBe(last);
    expect(plan.messages.some((entry) => entry.role === 'user')).toBeTruthy();
    assertPlanInvariants(preserved, plan, 'nudge-only window');
  });

  test('a real user prompt still outranks a nudge in the same window', () => {
    // The fallback must only fire when there is NO real user message: anchoring
    // on a trailing nudge while a real prompt sits earlier would drop the prompt
    // the model is working on.
    const realPrompt = message('user', 900);
    const nudge = {
      role: 'user',
      content: '[System notice: please continue working on the task. [End system notice]',
    };
    const preserved = [realPrompt, message('assistant', 2200), message('assistant', 900), nudge];
    const plan = planWindowTrim(preserved, 0, MODEL);
    expect(plan.messages).toContain(realPrompt);
    expect(plan.messages[0]).toBe(realPrompt);
    assertPlanInvariants(preserved, plan, 'real prompt with a nudge');
  });
});

describe('the window trimmer keeps its promises at every budget', () => {
  test('the anchor survives every budget from zero to the total', () => {
    const second = message('user', 900);
    const preserved = [
      message('assistant', 300),
      second,
      message('assistant', 700),
      toolBlock(2400, 'call-3')[1],
      message('user', 400),
      message('assistant', 500),
    ];
    // The tool row above is an orphan by construction (no assistant in this
    // slice), which is exactly the shape the planner must tolerate.
    const total = tokensOf(preserved);
    for (let budget = 0; budget <= total; budget += 37) {
      const plan = planWindowTrim(preserved, budget, MODEL);
      expect(plan.messages).toContain(preserved[4]);
      assertPlanInvariants(preserved, plan, `budget ${budget}`);
    }
  });

  test('the head is never an orphan tool row, at any budget', () => {
    // A tool-heavy window: every candidate cut that lands between an assistant
    // and its tool result has to be pushed forward.
    const preserved = [
      message('user', 700),
      ...toolBlock(1500, 'call-4'),
      message('assistant', 300),
      ...toolBlock(1200, 'call-5'),
      message('user', 200),
      ...toolBlock(2000, 'call-6'),
    ];
    const total = tokensOf(preserved);
    for (let budget = 0; budget <= total; budget += 100) {
      const plan = planWindowTrim(preserved, budget, MODEL);
      if (plan.droppedCount > 0) {
        expect(plan.messages[0]?.role).not.toBe('tool');
      }
      assertPlanInvariants(preserved, plan, `budget ${budget}`);
    }
  });

  test('a smaller budget never returns a longer window', () => {
    const preserved = [
      message('user', 500),
      message('assistant', 900),
      toolBlock(1800, 'call-7')[1],
      message('assistant', 400),
      message('user', 300),
      message('assistant', 1100),
    ];
    const total = tokensOf(preserved);
    let previousLength = Infinity;
    for (let budget = total + 200; budget >= 0; budget -= 50) {
      const plan = planWindowTrim(preserved, budget, MODEL);
      expect(plan.messages.length).toBeLessThanOrEqual(previousLength);
      previousLength = plan.messages.length;
      assertPlanInvariants(preserved, plan, `budget ${budget}`);
    }
  });

  test('randomised windows keep every invariant', () => {
    // A seeded sweep over shapes the hand-written fixtures do not cover: no user
    // row at all, tool rows at index 0, runs of tool rows at the tail, and
    // budgets both far below and far above the window.
    let seed = 987654321;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const roles = ['user', 'assistant', 'tool'];
    for (let trial = 0; trial < 40; trial += 1) {
      const length = 2 + (next() % 9);
      const preserved = [];
      for (let index = 0; index < length; index += 1) {
        const role = roles[next() % 3];
        preserved.push(
          message(
            role,
            200 + (next() % 4000),
            role === 'tool' ? { tool_call_id: `call-${trial}-${index}` } : {}
          )
        );
      }
      const total = tokensOf(preserved);
      for (const fraction of [0, 0.3, 0.7, 1.2]) {
        const budget =
          Math.sign(fraction) * Math.floor(total * fraction) - (fraction === 0 ? 500 : 100);
        const plan = planWindowTrim(preserved, budget, MODEL);
        assertPlanInvariants(preserved, plan, `trial ${trial} at ${fraction}`);
      }
    }
  });

  test('a budget too small for everything left is trimmed-insufficient', () => {
    const preserved = [
      message('user', 800),
      message('assistant', 1500),
      message('user', 300),
      message('assistant', 1500),
    ];
    const plan = planWindowTrim(preserved, 0, MODEL);
    expect(plan.stopReason).toBe('trimmed-insufficient');
    expect(plan.droppedCount).toBeGreaterThan(0);
    expect(tokensOf(plan.messages)).toBeGreaterThan(0);
    assertPlanInvariants(preserved, plan, 'insufficient');
  });

  test('the trim notice reads correctly for one message and for several', () => {
    const one = formatWindowTrimNotice(1);
    expect(one.startsWith('\n\n[Note: 1 earlier message was dropped')).toBeTruthy();
    expect(one).toContain('is not represented here');
    expect(one).not.toContain('{');
    const many = formatWindowTrimNotice(4);
    expect(many.startsWith('\n\n[Note: 4 earlier messages were dropped')).toBeTruthy();
    expect(many).toContain('are not represented here');
    expect(many).not.toContain('{');
  });

  test('a window that ends in a run of tool rows still reports a real trim or nothing', () => {
    // The cut would have to enter the final tool block, which the hard limit
    // forbids; alignment backs off to the start of the block — and when that
    // start is index 0 there is nothing left to drop.
    const preserved = [
      message('user', 900),
      message('tool', 2000, { tool_call_id: 'call-8' }),
      message('tool', 2000, { tool_call_id: 'call-9' }),
    ];
    const total = tokensOf(preserved);
    for (let budget = 0; budget <= total; budget += 100) {
      const plan = planWindowTrim(preserved, budget, MODEL);
      expect(plan.droppedCount).toBe(0);
      expect(plan.stopReason).toBe('nothing-droppable');
      expect(plan.messages).toBe(preserved);
      assertPlanInvariants(preserved, plan, `budget ${budget}`);
    }
  });
});

describe('the trim budget pays for the system prompt', () => {
  /**
   * Builds a string of at least `targetTokens` tokens from a repeated phrase.
   *
   * The system prompt in these checks has to be LARGE but its exact size does not
   * matter; a binary search over the repeat count keeps the fixture honest (a
   * hand-guessed character count would drift with the tokenizer) without pinning
   * a brittle number.
   *
   * @param {number} targetTokens - the token count to reach.
   * @returns {string} the filler text.
   */
  function fillerOfTokens(targetTokens) {
    const unit = 'alpha beta gamma delta epsilon ';
    let low = 0;
    let high = targetTokens * 8 + 100;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (countTextTokens(unit.repeat(mid), MODEL) < targetTokens) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return unit.repeat(low);
  }

  test('the window budget charges the header, the notice AND the system prompt', () => {
    expect(
      computePreservedWindowBudget({
        acceptanceBudget: 7372,
        headerTokens: 500,
        noticeTokens: 60,
        systemPromptTokens: 3712,
      })
    ).toBe(3100);
    // Leaving the system prompt out is exactly the bug: the planner then trims
    // until the WINDOW fits a budget that still has room for it.
    expect(
      computePreservedWindowBudget({
        acceptanceBudget: 7372,
        headerTokens: 500,
        noticeTokens: 60,
        systemPromptTokens: 0,
      }) -
        computePreservedWindowBudget({
          acceptanceBudget: 7372,
          headerTokens: 500,
          noticeTokens: 60,
          systemPromptTokens: 3712,
        })
    ).toBe(3712);
  });

  /**
   * The end-to-end shape of a compaction that is over the acceptance boundary
   * ONLY because of its system prompt.
   *
   * Returns what the orchestration needs to decide the trim budget, measured with
   * the real tokenizer: the summary header, the worst-case notice, the system
   * prompt, the preserved window and the acceptance boundary.
   *
   * @param {number} systemPromptTargetTokens - the size of the system prompt.
   * @returns {object} the fixture.
   */
  function trimBudgetFixture(systemPromptTargetTokens) {
    const numCtx = 8192;
    const acceptanceBudget = Math.floor(numCtx * 0.9);
    const systemMessage = message('system', 0, {
      content: fillerOfTokens(systemPromptTargetTokens),
    });
    const summaryMessage = {
      role: 'assistant',
      content: `${SUMMARY_PREAMBLE}\n\n${fillerOfTokens(600)}`,
    };
    const preserved = [
      message('assistant', 0, { content: fillerOfTokens(1200) }),
      message('user', 0, { content: fillerOfTokens(300) }),
      message('assistant', 0, { content: fillerOfTokens(900) }),
      message('user', 0, { content: fillerOfTokens(250) }),
      message('assistant', 0, { content: fillerOfTokens(900) }),
    ];
    const headerTokens = countMessagesTokens([summaryMessage], MODEL);
    const noticeTokens = countMessageTokens(
      { role: 'assistant', content: formatWindowTrimNotice(preserved.length) },
      MODEL
    );
    const systemPromptTokens = countMessagesTokens([systemMessage], MODEL);
    return {
      numCtx,
      acceptanceBudget,
      summaryMessage,
      preserved,
      headerTokens,
      noticeTokens,
      systemPromptTokens,
    };
  }

  test('a large system prompt makes the trim drop a message so the RESULT fits', () => {
    // The reproduction from the fix: numCtx 8192, a ~3712-token system prompt, a
    // post-summary total of ~7540 — over the 7372-token acceptance boundary. The
    // window fits the budget the planner used to get (system prompt omitted), so
    // nothing was dropped, the post-trim total stayed over, and the retry
    // re-summarised the summary. Charging the system prompt is what makes the
    // planner drop something and the TOTAL land under the boundary.
    const fixture = trimBudgetFixture(3712);
    const { acceptanceBudget, headerTokens, noticeTokens, preserved, systemPromptTokens } = fixture;
    const totalBeforeTrim =
      headerTokens + countMessagesTokens(preserved, MODEL) + systemPromptTokens;
    expect(systemPromptTokens > 3000 && systemPromptTokens < 4200).toBeTruthy();
    expect(totalBeforeTrim).toBeGreaterThan(acceptanceBudget);

    const windowBudget = computePreservedWindowBudget({
      acceptanceBudget,
      headerTokens,
      noticeTokens,
      systemPromptTokens,
    });
    const plan = planWindowTrim(preserved, windowBudget, MODEL);

    expect(plan.droppedCount).toBeGreaterThan(0);
    expect(plan.stopReason).toBe('trimmed');
    assertPlanInvariants(preserved, plan, 'system prompt charged');
    const totalAfterTrim =
      headerTokens + countMessagesTokens(plan.messages, MODEL) + noticeTokens + systemPromptTokens;
    expect(totalAfterTrim).toBeLessThanOrEqual(acceptanceBudget);
  });

  test('without the system prompt in the budget the same window fits and the retry fires', () => {
    // The regression, pinned: the OLD budget (header and notice only) leaves the
    // window room to fit, so the planner reports `already-fits`, the total stays
    // over the boundary by the size of the system prompt, and `shouldRetry` stays
    // true — which is what re-entered the recursion.
    const fixture = trimBudgetFixture(3712);
    const { acceptanceBudget, headerTokens, noticeTokens, preserved, systemPromptTokens } = fixture;
    const legacyBudget = acceptanceBudget - headerTokens - noticeTokens;
    const legacyPlan = planWindowTrim(preserved, legacyBudget, MODEL);
    expect(legacyPlan.droppedCount).toBe(0);
    expect(legacyPlan.stopReason).toBe('already-fits');
    const legacyTotal =
      headerTokens + countMessagesTokens(legacyPlan.messages, MODEL) + systemPromptTokens;
    expect(legacyTotal).toBeGreaterThan(acceptanceBudget);
  });

  test('a system prompt larger than the acceptance budget trims everything it can', () => {
    // The degenerate case: the system prompt alone exceeds the boundary, so the
    // window budget is negative. That is not an error — the planner drops every
    // message it legally can, the result is still over, and the caller's
    // retry/notice path reports it.
    const fixture = trimBudgetFixture(8000);
    const { acceptanceBudget, headerTokens, noticeTokens, preserved, systemPromptTokens } = fixture;
    const windowBudget = computePreservedWindowBudget({
      acceptanceBudget,
      headerTokens,
      noticeTokens,
      systemPromptTokens,
    });
    expect(windowBudget).toBeLessThan(0);
    const plan = planWindowTrim(preserved, windowBudget, MODEL);
    expect(plan.stopReason).toBe('trimmed-insufficient');
    // Everything legal goes: the oldest three messages, leaving the hoisted
    // anchor (the latest user message, at index 3) and the last message.
    expect(plan.messages).toStrictEqual([preserved[3], preserved[4]]);
    expect(plan.droppedCount).toBe(3);
    assertPlanInvariants(preserved, plan, 'degenerate system prompt');
    const totalAfterTrim =
      headerTokens + countMessagesTokens(plan.messages, MODEL) + noticeTokens + systemPromptTokens;
    expect(totalAfterTrim).toBeGreaterThan(acceptanceBudget);
  });

  test('orchestrate.ts charges the system prompt to the trim budget', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'),
      'utf8'
    );
    const callIndex = source.indexOf('computePreservedWindowBudget({');
    expect(callIndex).not.toBe(-1);
    const call = source.slice(callIndex, source.indexOf('});', callIndex));
    for (const charge of [
      'acceptanceBudget',
      'headerTokens',
      'noticeTokens',
      'systemPromptTokens',
    ]) {
      expect(call).toMatch(new RegExp(`\\b${charge}\\b`));
    }
    // And the planner is given THAT number, not the old header-only arithmetic.
    expect(source).toContain('planWindowTrim(preparedRecentMessages, windowBudget, model)');
  });
});

describe('the pipeline trims before it re-summarises', () => {
  test('orchestrate.ts drops the preserved window before it recurses', () => {
    // The regression this whole module exists for: a compaction that did not fit
    // used to re-enter `compactHistory` on the already-compacted array, so the
    // model was asked to summarise a summary. The trim has to come FIRST.
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'),
      'utf8'
    );
    const trimIndex = source.indexOf('planWindowTrim(');
    expect(trimIndex).not.toBe(-1);
    const retryIndex = source.indexOf('const retryResult = await compactHistory(');
    expect(retryIndex).not.toBe(-1);
    expect(trimIndex).toBeLessThan(retryIndex);
    // And the recursion is still gated on the result being over budget, so a
    // successful trim cannot pay for a stronger pass anyway.
    const gateIndex = source.lastIndexOf('if (shouldRetry && remainingRetries > 0)', retryIndex);
    expect(gateIndex !== -1 && gateIndex < retryIndex).toBeTruthy();
    expect(gateIndex).toBeGreaterThan(trimIndex);
  });
});

describe('the leftover distillation budget is spent before the re-summary', () => {
  test('the extra spend runs BETWEEN the trim and the retry recursion', () => {
    // The order is the whole feature: the trim is free (no model call) and it
    // costs context but not fidelity, so it goes first; the extra digests cost
    // model calls, so they are only spent when the trim was not enough; and
    // the retry recursion — a summary of a summary — is the last resort.
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'),
      'utf8'
    );
    const trimIndex = source.indexOf('planWindowTrim(preparedRecentMessages, windowBudget, model)');
    const extraIndex = source.indexOf('const extraDistill = await distillToolMessages(');
    const retryIndex = source.indexOf('const retryResult = await compactHistory(');
    expect(trimIndex).not.toBe(-1);
    expect(extraIndex).not.toBe(-1);
    expect(retryIndex).not.toBe(-1);
    expect(trimIndex).toBeLessThan(extraIndex);
    expect(extraIndex).toBeLessThan(retryIndex);
  });

  test('the extra spend is gated on the result STILL being over budget', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'),
      'utf8'
    );
    const extraIndex = source.indexOf('const extraDistill = await distillToolMessages(');
    const gateIndex = source.lastIndexOf('if (shouldRetry) {', extraIndex);
    expect(gateIndex).not.toBe(-1);
    expect(extraIndex).toBeGreaterThan(gateIndex);
    // And the gate is the POST-TRIM verdict: the trim block comes before it.
    const trimIndex = source.indexOf('planWindowTrim(preparedRecentMessages, windowBudget, model)');
    expect(trimIndex).toBeLessThan(gateIndex);
    // The aborted verdict is thrown BEFORE the gate, so nothing is spent on a
    // compaction that is going to be refused.
    const abortIndex = source.indexOf('if (verdict.aborted)');
    expect(abortIndex !== -1 && abortIndex < gateIndex).toBeTruthy();
  });

  test('the extra spend draws on the SAME distillation budget', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'),
      'utf8'
    );
    const extraIndex = source.indexOf('const extraDistill = await distillToolMessages(');
    const extraCall = source.slice(extraIndex, source.indexOf('\n    );', extraIndex));
    // The budget object is handed to the extra pass…
    expect(extraCall).toMatch(/\bdistillBudget\b/u);
    // …and the extra pass's prefill is charged back to it, so the total
    // prefill of ONE compaction still respects the window's budget.
    expect(source).toContain('distillBudget.usedTokens += extraDistill.prefillTokens;');
    // And the calls are bounded by the ceiling, so the spend cannot blow up the
    // latency even when the budget would allow more.
    expect(extraCall).toMatch(/TOOL_DISTILL_EXTRA_CALLS_MAX/u);
  });

  test('the extra spend skips the rows the first pass already dealt with', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'),
      'utf8'
    );
    const extraIndex = source.indexOf('const extraDistill = await distillToolMessages(');
    const extraCall = source.slice(extraIndex, source.indexOf('\n    );', extraIndex));
    expect(extraCall).toMatch(/handledRows/u);
    // The bookkeeping is per-ROW and per-PASS: the digests and the failures of
    // the WINDOW pass are what is excluded, and the exclusion set is built in
    // the index space of the array the extra pass walks (the trimmer re-indexes
    // the window, so the two index spaces are not the same).
    expect(source).toContain('recentDistill.distilledIndices');
    expect(source).toContain('recentDistill.failedIndices');
    expect(source).toContain('resultWindowSources = trimPlan.keptIndices;');
  });

  test('the verdict is re-taken after the extra spend', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'),
      'utf8'
    );
    const extraIndex = source.indexOf('const extraDistill = await distillToolMessages(');
    const retryIndex = source.indexOf('const retryResult = await compactHistory(');
    const sliceText = source.slice(extraIndex, retryIndex);
    expect(sliceText).toMatch(
      /countMessagesTokens\(digestedMessages, model\) \+ resolvedSystemPromptTokens/
    );
    expect(sliceText).toMatch(/shouldRetry = numCtx > 0 && newTokenCount > acceptanceBudget;/);
    // And the digests are only kept when they made the result SMALLER: a digest
    // can be longer than the output it replaced, and spending the budget must
    // never make the result bigger.
    expect(sliceText).toContain('if (distilledTokens < newTokenCount) {');
  });
});

describe('the trim budget and the recent-files stub', () => {
  test('the window budget is charged the summary alone', () => {
    // The stub used to be part of the trim's header charge — so the planner
    // dropped preserved turns to fund it. It is now attached AFTER the trim (and
    // after any retry), out of whatever room the final result leaves, so the trim
    // must not pay for a message it never sees.
    const summary = { role: 'assistant', content: 'x'.repeat(800) };
    const charges = { acceptanceBudget: 7372, noticeTokens: 60, systemPromptTokens: 3712 };
    const budget = computePreservedWindowBudget({
      ...charges,
      headerTokens: countMessagesTokens([summary], MODEL),
    });
    const chargesWithStub = {
      ...charges,
      headerTokens:
        countMessagesTokens([summary], MODEL) +
        countMessageTokens({ role: 'assistant', content: 'y'.repeat(400) }, MODEL) -
        countMessageTokens({ role: 'assistant', content: '' }, MODEL),
    };
    // The arithmetic is still decisive — a charge that IS included shrinks the
    // budget by exactly its own cost — which is what makes "the stub is not in
    // it" a meaningful statement rather than a vacuous one.
    expect(computePreservedWindowBudget(chargesWithStub)).toBeLessThan(budget);
  });

  test('orchestrate.ts keeps the stub out of the trim, and out of the retry', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'),
      'utf8'
    );

    // The header the trim charges is the summary alone.
    expect(source).toContain('const headerTokens = countMessagesTokens([summaryMessage], model);');
    // The rebuild after a trim has no stub in it: the result is the summary
    // plus the trimmed window, and the stub is attached later (see below).
    const rebuild = source.indexOf('newMessages = [resultSummary, ...resultWindow];');
    expect(rebuild).not.toBe(-1);
    const rebuildBlock = source.slice(Math.max(0, rebuild - 400), rebuild);
    expect(rebuildBlock).not.toContain('recentFilesMessage');
    expect(source).toContain('resultWindow = trimPlan.messages;');
    expect(source).toMatch(/resultSummary = \{\s*\.\.\.summaryMessage,/u);
    expect(source).toContain('planWindowTrim(preparedRecentMessages, windowBudget, model)');
    // And the retry does not forward the rows — `newMessages` has no stub at that
    // point, so a second one would be stacked on the recursion's result.
    const retry = source.slice(source.indexOf('const retryResult = await compactHistory('));
    const retryCall = retry.slice(0, retry.indexOf('\n    );'));
    // Comments are stripped first: the call carries a comment that names the two
    // parameters, and a check the comment can satisfy would pass on a regression.
    const retryArguments = retryCall.replaceAll(/\/\/[^\n]*/gu, '');
    expect(retryArguments).not.toMatch(/\brecentFiles(Root)?\b/u);
    expect(retryArguments).toMatch(/\bmodel,\n\s+newMessages,/u);
  });
});

describe('the retry invariant', () => {
  test('the stub is built ONCE, after the retry, and only claimed once attached', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'),
      'utf8'
    );
    const retryIndex = source.indexOf('const retryResult = await compactHistory(');
    const buildIndex = source.indexOf('await buildRecentFilesMessage(');
    const attachIndex = source.indexOf('attachRecentFilesMessage(');
    const progressIndex = source.indexOf('Re-attached the ');
    expect(
      retryIndex !== -1 && buildIndex !== -1 && attachIndex !== -1 && progressIndex !== -1
    ).toBeTruthy();
    expect(retryIndex).toBeLessThan(buildIndex);
    expect(buildIndex).toBeLessThan(attachIndex);
    expect(attachIndex).toBeLessThan(progressIndex);
    // The summariser's input: nothing between the result array and the recursion
    // may build, splice or mention a stub, so the array the summariser sees has
    // none — and no file content is summarised into prose.
    const beforeRetry = source.slice(
      source.indexOf('let newMessages: ChatMessage[] = [summaryMessage'),
      retryIndex
    );
    for (const forbidden of [
      'buildRecentFilesMessage',
      'attachRecentFilesMessage',
      'recentFilesPlan',
    ]) {
      // A RegExp rather than `String#includes` on purpose: the lint rule that
      // rewrites `includes` to a Set turns a substring test into a character
      // test, which would make this check vacuous.
      expect(new RegExp(forbidden, 'u').test(beforeRetry)).toBeFalsy();
    }
    // And the assistant role is pinned where the message is actually built.
    const recentFilesSource = readFileSync(
      path.join(REPO_ROOT, 'src/services/compact/recentFiles.ts'),
      'utf8'
    );
    expect(
      recentFilesSource.includes('candidate.splice(1, 0, params.message)') &&
        source.includes("recentFilesMessage = { role: 'assistant', content: recentFilesPlan.text }")
    ).toBeTruthy();
  });

  test('a retried compaction still ends with the stub attached', async () => {
    // The behaviour behind the ordering: the budget is charged against the FINAL
    // history. On the pre-retry sizes the only honest answer is "no stub"; after
    // a retry there is room — which is exactly the case that used to end with the
    // progress line printed and no stub in the result.
    const numCtx = 8192;
    const acceptanceBudget = Math.floor(numCtx * 0.9);
    const systemPromptTokens = 1000;

    const tooTight = computeBudgetForResult({
      numCtx,
      acceptanceBudget,
      oldTokenCount: 20_000,
      resultTokens: acceptanceBudget - 60,
    });
    expect(tooTight).toBe(0);

    const afterRetryTokens = 3600;
    const budget = computeBudgetForResult({
      numCtx,
      acceptanceBudget,
      oldTokenCount: 20_000,
      resultTokens: afterRetryTokens,
    });
    expect(budget).toBeGreaterThan(RECENT_FILES_MIN_TOKENS);

    const plan = await buildRecentFilesMessage({
      files: [recentFileRow('/work/status-bar.ts')],
      budgetTokens: budget,
      model: MODEL,
      redactSecrets: true,
      readExcerpt: async () => 'export const status = 1;\n',
      now: NOW,
    });
    expect(plan.text).not.toBe('');

    const summary = { role: 'assistant', content: 'x'.repeat(600) };
    const window = [{ role: 'user', content: 'y'.repeat(2000) }];
    const finalMessages = [summary, ...window];
    const finalTokens = countMessagesTokens(finalMessages, MODEL) + systemPromptTokens;
    const attached = attachRecentFilesMessage({
      messages: finalMessages,
      message: { role: 'assistant', content: plan.text },
      model: MODEL,
      systemPromptTokens,
      oldTokenCount: 20_000,
      acceptanceBudget,
    });
    expect(attached).not.toBeNull();
    expect(attached[1].content).toBe(plan.text);
    const total = countMessagesTokens(attached, MODEL) + systemPromptTokens;
    expect(total).toBeLessThan(20_000);
    expect(total).toBeLessThanOrEqual(acceptanceBudget);
    // The stub is a message on top of the finished history, not a rewrite of it.
    expect(attached).toHaveLength(finalMessages.length + 1);
    expect(countMessagesTokens(finalMessages, MODEL)).toBe(finalTokens - systemPromptTokens);
  });
});
