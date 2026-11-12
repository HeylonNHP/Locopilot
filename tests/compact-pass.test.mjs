/**
 * The pass environment and the result draft (src/services/compact/pass.ts): the
 * facts a pass derives once, the count every path is measured with, and the
 * verdict that belongs to each array.
 *
 * The end-to-end transcripts in `compact-orchestrate.test.mjs` pin the same
 * behaviour in context; these tests pin the arithmetic itself, case by case,
 * which is where a boundary rule (an infinite window is not bounded) is legible.
 *
 * No network, no model, except the one `distillPass` test, which is handed a
 * fake provider.
 */

import { describe, expect, test } from '@jest/globals';

import { COMPACT_ACCEPTANCE_HEADROOM } from '../src/services/compact/constants.ts';
import {
  createPassEnv,
  draftResult,
  exceedsAcceptance,
  FIRST_ATTEMPT,
  resultTokens,
  withMessages,
} from '../src/services/compact/pass.ts';
import { countMessagesTokens } from '../src/services/tokenizer.ts';

const MODEL = 'gpt-4o';
const ctx = { providerId: 'ollama', baseUrl: 'http://127.0.0.1:1' };
const user = (text) => ({ role: 'user', content: text });
const system = (text) => ({ role: 'system', content: text });

/** A request with no window unless the test says otherwise. */
const request = (numCtx) => ({ ctx, model: MODEL, numCtx });

describe('the pass environment', () => {
  test('counts the system prompt into the OLD count once', () => {
    const messages = [system('a system prompt'), user('hello')];
    const env = createPassEnv(request(8192), messages, FIRST_ATTEMPT);
    expect(env.systemMessages).toStrictEqual([messages[0]]);
    expect(env.systemPromptTokens).toBe(countMessagesTokens([messages[0]], MODEL));
    // `messages` carries its own system row, so it is counted by the array count.
    expect(env.oldTokenCount).toBe(countMessagesTokens(messages, MODEL));
  });

  test('adds a BORROWED system prompt the array does not carry', () => {
    // The retry pass: an assistant summary and preserved turns, no system row.
    const messages = [user('hello')];
    const borrowed = 900;
    const env = createPassEnv(request(8192), messages, {
      ...FIRST_ATTEMPT,
      systemPromptTokens: borrowed,
    });
    expect(env.systemMessages).toStrictEqual([]);
    expect(env.systemPromptTokens).toBe(borrowed);
    expect(env.oldTokenCount).toBe(countMessagesTokens(messages, MODEL) + borrowed);
  });

  test('derives the boundary and the two distillation caps from the window', () => {
    for (const numCtx of [4096, 32768, 131072]) {
      const env = createPassEnv(request(numCtx), [user('x')], FIRST_ATTEMPT);
      expect(env.acceptanceBudget).toBe(Math.floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM));
      // 4096 and 32768 both clamp to the two-call minimum; 131072 is eight.
      expect(env.distillCallCap).toBe(numCtx === 131072 ? 8 : 2);
      expect(env.distillBudget.totalTokens).toBeGreaterThan(0);
      expect(env.distillBudget.usedTokens).toBe(0);
    }
  });
});

describe('the count of a result', () => {
  test('is the array plus the system prompt the caller re-prepends', () => {
    const messages = [system('a system prompt'), user('hello')];
    const env = createPassEnv(request(8192), messages, FIRST_ATTEMPT);
    const result = [user('a summary'), user('a kept turn')];
    expect(resultTokens(env, result)).toBe(
      countMessagesTokens(result, MODEL) + env.systemPromptTokens
    );
  });
});

describe('the acceptance verdict', () => {
  const env = createPassEnv(request(1000), [user('x')], FIRST_ATTEMPT);

  test('is "over" only above the boundary, and the boundary itself is not over', () => {
    expect(env.acceptanceBudget).toBe(900);
    expect(exceedsAcceptance(env, 900)).toBe(false);
    expect(exceedsAcceptance(env, 901)).toBe(true);
  });

  test('never fires with no window', () => {
    // A window of 0 or less means "no window": there is no boundary to be over.
    for (const numCtx of [0, -1]) {
      const noWindow = createPassEnv(request(numCtx), [user('x')], FIRST_ATTEMPT);
      expect(exceedsAcceptance(noWindow, 10_000_000)).toBe(false);
    }
  });

  test('does not bound an infinite window — the rule a merged predicate would lose', () => {
    // `budget.ts` refuses `Infinity` because it must; this predicate must NOT:
    // an infinite boundary makes every finite result fit, and a merged check
    // would call every compaction "over" and re-summarise it.
    const infinite = createPassEnv(request(Number.POSITIVE_INFINITY), [user('x')], FIRST_ATTEMPT);
    expect(exceedsAcceptance(infinite, 10_000_000)).toBe(false);
  });
});

describe('the result draft', () => {
  const env = createPassEnv(request(1000), [user('x')], FIRST_ATTEMPT);
  const summary = user('the summary');
  const window = [user('kept one'), user('kept two')];

  test('is the summary, then the window, counted and judged together', () => {
    const draft = draftResult(env, summary, window, [0, 1]);
    expect(draft.messages).toStrictEqual([summary, ...window]);
    expect(draft.summary).toBe(summary);
    expect(draft.window).toBe(window);
    expect(draft.windowSources).toStrictEqual([0, 1]);
    expect(draft.tokens).toBe(resultTokens(env, draft.messages));
    expect(draft.overBudget).toBe(exceedsAcceptance(env, draft.tokens));
  });

  test('takes the caller’s own count when it has one, but judges it the same way', () => {
    const draft = draftResult(env, summary, window, [0, 1], 901);
    expect(draft.tokens).toBe(901);
    expect(draft.overBudget).toBe(true);
    const fits = draftResult(env, summary, window, [0, 1], 899);
    expect(fits.overBudget).toBe(false);
  });

  test('a different array is re-measured and re-judged, never carried over', () => {
    // The stub's attach inserts a message: the count and the verdict must both
    // move with the array, or a stale "fits" would survive a message that does
    // not fit.
    const draft = draftResult(env, summary, window, [0, 1], 899);
    expect(draft.overBudget).toBe(false);
    const filler = Array.from(
      { length: 200 },
      (_, index) => `line ${index}: value=${(index * 7919) % 1009} token-${index}`
    ).join('\n');
    const grown = withMessages(env, draft, [...draft.messages, system(filler)]);
    expect(grown.messages).toHaveLength(4);
    expect(grown.tokens).toBe(resultTokens(env, grown.messages));
    expect(grown.overBudget).toBe(true);
    // Everything but the array, its count and its verdict is carried over.
    expect(grown.summary).toBe(summary);
    expect(grown.windowSources).toStrictEqual([0, 1]);
  });
});
