#!/usr/bin/env node
/**
 * Tests for the preserved-window trimmer.
 *
 * Run with: npx tsx scripts/test-compact-trim.mjs
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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatWindowTrimNotice, SUMMARY_PREAMBLE } from '../src/services/compact/constants.ts';
import {
  computePreservedWindowBudget,
  planWindowTrim,
} from '../src/services/compact/windowTrim.ts';
import {
  countMessagesTokens,
  countMessageTokens,
  countTextTokens,
} from '../src/services/tokenizer.ts';

const MODEL = 'gpt-4o';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;

/**
 * Runs one check and records the result.
 *
 * @param {string} label - what the check asserts.
 * @param {() => void} fn - the check.
 */
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
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
  // 4: the last message is never dropped.
  if (preserved.length > 0) {
    assert.equal(plan.messages.at(-1), preserved.at(-1), `${label}: the last message was dropped`);
  }
  // 5: no false trim.
  if (plan.droppedCount === 0) {
    assert.ok(
      plan.stopReason === 'already-fits' || plan.stopReason === 'nothing-droppable',
      `${label}: dropped nothing but reported "${plan.stopReason}"`
    );
  } else {
    assert.ok(
      plan.stopReason === 'trimmed' || plan.stopReason === 'trimmed-insufficient',
      `${label}: dropped ${plan.droppedCount} but reported "${plan.stopReason}"`
    );
    // 3: no orphan head.
    assert.notEqual(plan.messages[0]?.role, 'tool', `${label}: the plan starts with a tool row`);
    assert.ok(plan.messages.length > 0, `${label}: the plan is empty`);
  }
  // 1: subsequence plus at most one hoisted anchor.
  let previous = -1;
  let hoists = 0;
  const usedIndices = new Set();
  plan.messages.forEach((entry, position) => {
    const found = preserved.indexOf(entry);
    assert.ok(found !== -1, `${label}: the plan carries a message that is not in the window`);
    assert.ok(!usedIndices.has(found), `${label}: a message appears twice in the plan`);
    usedIndices.add(found);
    if (found <= previous) {
      assert.equal(position, 0, `${label}: the plan reordered messages beyond the anchor hoist`);
      hoists += 1;
      assert.equal(hoists, 1, `${label}: more than one message was hoisted`);
    }
    previous = found;
  });
}

console.log('the window trimmer leaves a window that already fits alone');

check('an empty window is already-fits', () => {
  const plan = planWindowTrim([], 1000, MODEL);
  assert.equal(plan.droppedCount, 0);
  assert.equal(plan.stopReason, 'already-fits');
  assert.deepEqual(plan.messages, []);
});

check('a window that fits is returned by reference, untouched', () => {
  const preserved = [message('user', 400), message('assistant', 800), message('user', 200)];
  const plan = planWindowTrim(preserved, tokensOf(preserved), MODEL);
  assert.equal(plan.messages, preserved, 'the untouched window was copied');
  assert.equal(plan.droppedCount, 0);
  assert.equal(plan.droppedTokens, 0);
  assert.equal(plan.stopReason, 'already-fits');
});

check('a single-message window drops nothing even at a zero budget', () => {
  const preserved = [message('user', 4000)];
  for (const budget of [0, -500, tokensOf(preserved) - 1]) {
    const plan = planWindowTrim(preserved, budget, MODEL);
    assert.equal(plan.droppedCount, 0, `budget ${budget} dropped the only message`);
    assert.equal(plan.messages, preserved);
    assert.equal(plan.stopReason, 'nothing-droppable');
  }
});

console.log('the window trimmer drops the oldest messages first');

check('exactly one message is dropped when the budget affords one', () => {
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
  assert.equal(plan.droppedCount, 1, `dropped ${plan.droppedCount} messages, expected 1`);
  assert.equal(plan.messages[0], preserved[1], 'the wrong message was dropped');
  assert.equal(plan.messages.length, preserved.length - 1);
  assert.equal(
    plan.droppedTokens,
    tokensOfOne(preserved[0]),
    'the dropped-token count does not match the message that was dropped'
  );
  assert.equal(plan.stopReason, 'trimmed');
  assertPlanInvariants(preserved, plan, 'one message');
});

check('a tool block is dropped as a unit, never leaving an orphan head', () => {
  const [assistant, tool] = toolBlock(3000, 'call-1');
  const preserved = [assistant, tool, message('assistant', 400), message('user', 200)];
  const plan = planWindowTrim(
    preserved,
    tokensOf(preserved) - tokensOfOne(assistant) - tokensOfOne(tool),
    MODEL
  );
  assert.equal(plan.droppedCount, 2, `dropped ${plan.droppedCount}, expected the whole block`);
  assert.equal(plan.messages[0], preserved[2], 'the head is not the message after the block');
  assert.notEqual(plan.messages[0].role, 'tool');
  assertPlanInvariants(preserved, plan, 'tool block');
});

check('the anchor is hoisted to the front when the cut would pass it', () => {
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
  assert.ok(plan.droppedCount > 0, 'a one-pair budget dropped nothing');
  assert.equal(plan.messages[0], anchor, 'the anchor was not hoisted to the front');
  assert.equal(
    plan.messages.filter((entry) => entry === anchor).length,
    1,
    'the anchor was duplicated by the hoist'
  );
  assert.deepEqual(
    plan.messages,
    [anchor, last],
    'the hoisted plan is not the anchor plus the newest message'
  );
  assert.equal(plan.droppedCount, 4, `dropped ${plan.droppedCount} messages, expected 4`);
  assert.equal(plan.stopReason, 'trimmed');
  assertPlanInvariants(preserved, plan, 'hoisted anchor');
});

check('a synthetic nudge is never mistaken for the anchor', () => {
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
  assert.ok(plan.messages.includes(realPrompt), 'the real user prompt was dropped for a nudge');
  assert.equal(plan.messages[0], realPrompt);
  assertPlanInvariants(preserved, plan, 'synthetic nudge');
});

check('a window whose only user row is a nudge keeps that nudge', () => {
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
  assert.ok(plan.droppedCount > 0, 'a zero budget dropped nothing');
  assert.ok(plan.messages.includes(nudge), 'the only user-role row was dropped');
  assert.equal(plan.messages[0], nudge, 'the nudge was not hoisted to the front');
  assert.equal(
    plan.messages.filter((entry) => entry === nudge).length,
    1,
    'the nudge anchor was duplicated'
  );
  assert.equal(plan.messages.at(-1), last, 'the last message was dropped');
  assert.ok(
    plan.messages.some((entry) => entry.role === 'user'),
    'the trimmed window has no user-role row at all'
  );
  assertPlanInvariants(preserved, plan, 'nudge-only window');
});

check('a real user prompt still outranks a nudge in the same window', () => {
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
  assert.ok(plan.messages.includes(realPrompt), 'the real user prompt was dropped');
  assert.equal(plan.messages[0], realPrompt, 'the real prompt is not the hoisted anchor');
  assertPlanInvariants(preserved, plan, 'real prompt with a nudge');
});

console.log('the window trimmer keeps its promises at every budget');

check('the anchor survives every budget from zero to the total', () => {
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
    assert.ok(
      plan.messages.includes(preserved[4]),
      `budget ${budget} dropped the latest real user message`
    );
    assertPlanInvariants(preserved, plan, `budget ${budget}`);
  }
});

check('the head is never an orphan tool row, at any budget', () => {
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
      assert.notEqual(
        plan.messages[0]?.role,
        'tool',
        `budget ${budget} produced a window that starts with a tool result`
      );
    }
    assertPlanInvariants(preserved, plan, `budget ${budget}`);
  }
});

check('a smaller budget never returns a longer window', () => {
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
    assert.ok(
      plan.messages.length <= previousLength,
      `a budget of ${budget} returned ${plan.messages.length} messages, more than the larger budget's ${previousLength}`
    );
    previousLength = plan.messages.length;
    assertPlanInvariants(preserved, plan, `budget ${budget}`);
  }
});

check('randomised windows keep every invariant', () => {
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

check('a budget too small for everything left is trimmed-insufficient', () => {
  const preserved = [
    message('user', 800),
    message('assistant', 1500),
    message('user', 300),
    message('assistant', 1500),
  ];
  const plan = planWindowTrim(preserved, 0, MODEL);
  assert.equal(plan.stopReason, 'trimmed-insufficient');
  assert.ok(plan.droppedCount > 0, 'nothing was dropped at a zero budget');
  assert.ok(
    tokensOf(plan.messages) > 0,
    'the surviving window was expected to stay over a zero budget'
  );
  assertPlanInvariants(preserved, plan, 'insufficient');
});

check('the trim notice reads correctly for one message and for several', () => {
  const one = formatWindowTrimNotice(1);
  assert.ok(one.startsWith('\n\n[Note: 1 earlier message was dropped'), one);
  assert.ok(one.includes('is not represented here'), one);
  assert.ok(!one.includes('{'), `a placeholder survived: ${one}`);
  const many = formatWindowTrimNotice(4);
  assert.ok(many.startsWith('\n\n[Note: 4 earlier messages were dropped'), many);
  assert.ok(many.includes('are not represented here'), many);
  assert.ok(!many.includes('{'), `a placeholder survived: ${many}`);
});

check('a window that ends in a run of tool rows still reports a real trim or nothing', () => {
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
    assert.equal(
      plan.droppedCount,
      0,
      `budget ${budget} dropped ${plan.droppedCount} — the window starts with the only legal cut`
    );
    assert.equal(plan.stopReason, 'nothing-droppable');
    assert.equal(plan.messages, preserved);
    assertPlanInvariants(preserved, plan, `budget ${budget}`);
  }
});

console.log('the trim budget pays for the system prompt');

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

check('the window budget charges the header, the notice AND the system prompt', () => {
  assert.equal(
    computePreservedWindowBudget({
      acceptanceBudget: 7372,
      headerTokens: 500,
      noticeTokens: 60,
      systemPromptTokens: 3712,
    }),
    3100,
    'the window budget does not subtract all three non-droppable charges'
  );
  // Leaving the system prompt out is exactly the bug: the planner then trims
  // until the WINDOW fits a budget that still has room for it.
  assert.equal(
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
      }),
    3712,
    'the system prompt is not charged at its own size'
  );
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
  const systemMessage = message('system', 0, { content: fillerOfTokens(systemPromptTargetTokens) });
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

check('a large system prompt makes the trim drop a message so the RESULT fits', () => {
  // The reproduction from the fix: numCtx 8192, a ~3712-token system prompt, a
  // post-summary total of ~7540 — over the 7372-token acceptance boundary. The
  // window fits the budget the planner used to get (system prompt omitted), so
  // nothing was dropped, the post-trim total stayed over, and the retry
  // re-summarised the summary. Charging the system prompt is what makes the
  // planner drop something and the TOTAL land under the boundary.
  const fixture = trimBudgetFixture(3712);
  const { acceptanceBudget, headerTokens, noticeTokens, preserved, systemPromptTokens } = fixture;
  const totalBeforeTrim = headerTokens + countMessagesTokens(preserved, MODEL) + systemPromptTokens;
  assert.ok(
    systemPromptTokens > 3000 && systemPromptTokens < 4200,
    `the fixture's system prompt is ${systemPromptTokens} tokens, expected ~3712`
  );
  assert.ok(
    totalBeforeTrim > acceptanceBudget,
    `the fixture is not over the boundary (${totalBeforeTrim} <= ${acceptanceBudget})`
  );

  const windowBudget = computePreservedWindowBudget({
    acceptanceBudget,
    headerTokens,
    noticeTokens,
    systemPromptTokens,
  });
  const plan = planWindowTrim(preserved, windowBudget, MODEL);

  assert.ok(plan.droppedCount > 0, 'nothing was dropped — the trim cannot reach acceptance');
  assert.equal(plan.stopReason, 'trimmed', `the trim stopped as "${plan.stopReason}"`);
  assertPlanInvariants(preserved, plan, 'system prompt charged');
  const totalAfterTrim =
    headerTokens + countMessagesTokens(plan.messages, MODEL) + noticeTokens + systemPromptTokens;
  assert.ok(
    totalAfterTrim <= acceptanceBudget,
    `the trimmed result is still over the boundary (${totalAfterTrim} > ${acceptanceBudget}) — the retry would fire`
  );
});

check('without the system prompt in the budget the same window fits and the retry fires', () => {
  // The regression, pinned: the OLD budget (header and notice only) leaves the
  // window room to fit, so the planner reports `already-fits`, the total stays
  // over the boundary by the size of the system prompt, and `shouldRetry` stays
  // true — which is what re-entered the recursion.
  const fixture = trimBudgetFixture(3712);
  const { acceptanceBudget, headerTokens, noticeTokens, preserved, systemPromptTokens } = fixture;
  const legacyBudget = acceptanceBudget - headerTokens - noticeTokens;
  const legacyPlan = planWindowTrim(preserved, legacyBudget, MODEL);
  assert.equal(legacyPlan.droppedCount, 0, 'the legacy budget dropped something after all');
  assert.equal(legacyPlan.stopReason, 'already-fits');
  const legacyTotal =
    headerTokens + countMessagesTokens(legacyPlan.messages, MODEL) + systemPromptTokens;
  assert.ok(
    legacyTotal > acceptanceBudget,
    `the legacy budget reached acceptance by itself (${legacyTotal} <= ${acceptanceBudget}) — the fixture proves nothing`
  );
});

check('a system prompt larger than the acceptance budget trims everything it can', () => {
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
  assert.ok(windowBudget < 0, `the fixture's window budget is ${windowBudget}, expected negative`);
  const plan = planWindowTrim(preserved, windowBudget, MODEL);
  assert.equal(plan.stopReason, 'trimmed-insufficient');
  // Everything legal goes: the oldest three messages, leaving the hoisted
  // anchor (the latest user message, at index 3) and the last message.
  assert.deepEqual(
    plan.messages,
    [preserved[3], preserved[4]],
    'the maximal trim did not leave exactly the anchor plus the last message'
  );
  assert.equal(plan.droppedCount, 3, `dropped ${plan.droppedCount} messages, expected 3`);
  assertPlanInvariants(preserved, plan, 'degenerate system prompt');
  const totalAfterTrim =
    headerTokens + countMessagesTokens(plan.messages, MODEL) + noticeTokens + systemPromptTokens;
  assert.ok(
    totalAfterTrim > acceptanceBudget,
    'the fixture does not stay over the boundary, so the retry path is not exercised'
  );
});

check('orchestrate.ts charges the system prompt to the trim budget', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'), 'utf8');
  const callIndex = source.indexOf('computePreservedWindowBudget({');
  assert.notEqual(callIndex, -1, 'orchestrate.ts does not use the shared window budget');
  const call = source.slice(callIndex, source.indexOf('});', callIndex));
  for (const charge of ['acceptanceBudget', 'headerTokens', 'noticeTokens', 'systemPromptTokens']) {
    assert.match(
      call,
      new RegExp(`\\b${charge}\\b`),
      `the window budget does not charge ${charge}`
    );
  }
  // And the planner is given THAT number, not the old header-only arithmetic.
  assert.ok(
    source.includes('planWindowTrim(preparedRecentMessages, windowBudget, model)'),
    'the planner is not called with the computed window budget'
  );
});

console.log('the pipeline trims before it re-summarises');

check('orchestrate.ts drops the preserved window before it recurses', () => {
  // The regression this whole module exists for: a compaction that did not fit
  // used to re-enter `compactHistory` on the already-compacted array, so the
  // model was asked to summarise a summary. The trim has to come FIRST.
  const source = readFileSync(path.join(REPO_ROOT, 'src/services/compact/orchestrate.ts'), 'utf8');
  const trimIndex = source.indexOf('planWindowTrim(');
  assert.ok(trimIndex !== -1, 'orchestrate.ts never plans a window trim');
  const retryIndex = source.indexOf('const retryResult = await compactHistory(');
  assert.ok(retryIndex !== -1, 'orchestrate.ts has no retry recursion to compare against');
  assert.ok(
    trimIndex < retryIndex,
    'the retry recursion runs BEFORE the window trim — a summary of a summary is back'
  );
  // And the recursion is still gated on the result being over budget, so a
  // successful trim cannot pay for a stronger pass anyway.
  const gateIndex = source.lastIndexOf('if (shouldRetry && remainingRetries > 0)', retryIndex);
  assert.ok(gateIndex !== -1 && gateIndex < retryIndex, 'the retry is no longer gated');
  assert.ok(gateIndex > trimIndex, 'the trim does not run before the retry gate');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
