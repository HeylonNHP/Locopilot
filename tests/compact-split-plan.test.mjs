/**
 * `planCompactionSplit` (src/services/compact/split.ts): the split the
 * compaction runs on, with the fallback ladder for a history that leaves too
 * little to summarise.
 *
 * The ladder used to live inline in `compactHistory`; these tests pin each
 * branch. Every ladder test first proves the PLAIN split left the slice under
 * `MIN_SUMMARISE_TOKENS` with something preserved, because without that the
 * ladder never runs and the test would be checking the plain split.
 *
 * No network, no model.
 */

import { describe, expect, test } from '@jest/globals';

import { MIN_SUMMARISE_TOKENS } from '../src/services/compact/constants.ts';
import { planCompactionSplit, splitHistoryForCompaction } from '../src/services/compact/split.ts';
import { countMessagesTokens } from '../src/services/tokenizer.ts';

const MODEL = 'test-model';
const NUM_CTX = 4096;

/** A message of `words` tokens or so (one token per "word "). */
const message = (role, words, label = '') => ({
  role,
  content: `${label} ${'word '.repeat(words)}`.trim(),
});

/** What the plain split says, to prove a ladder test reaches the ladder. */
function plain(history) {
  const split = splitHistoryForCompaction(history, MODEL, NUM_CTX, 1);
  return {
    split,
    summariseTokens: countMessagesTokens(split.messagesToSummarise, MODEL),
  };
}

describe('a split with enough to summarise is returned as it is', () => {
  test('the plan equals the plain split, and the slice is counted once', () => {
    const history = Array.from({ length: 14 }, (_, index) =>
      message(index % 2 === 0 ? 'user' : 'assistant', 70, `m${index}`)
    );
    const { split: expected, summariseTokens: expectedTokens } = plain(history);
    expect(expectedTokens).toBeGreaterThanOrEqual(MIN_SUMMARISE_TOKENS);

    const { split, summariseTokens } = planCompactionSplit(history, MODEL, NUM_CTX, 1);
    expect(split).toStrictEqual(expected);
    expect(summariseTokens).toBe(expectedTokens);
  });
});

describe('the fallback ladder', () => {
  test('the anchor is not the first message: cut at the anchor', () => {
    const history = [
      message('user', 70, 'u1'),
      message('assistant', 70, 'a1'),
      message('user', 70, 'u2'),
      message('assistant', 70, 'a2'),
      message('user', 20, 'u3'),
    ];
    // The branch proof: the plain split summarises too little, with a window.
    const before = plain(history);
    expect(before.summariseTokens).toBeLessThan(MIN_SUMMARISE_TOKENS);
    expect(before.split.preservedRecentMessages.length).toBeGreaterThan(0);

    const { split, summariseTokens } = planCompactionSplit(history, MODEL, NUM_CTX, 1);
    // Everything before the latest user prompt is summarised; the prompt stays verbatim.
    expect(split.messagesToSummarise).toStrictEqual(history.slice(0, 4));
    expect(split.preservedRecentMessages).toStrictEqual(history.slice(4));
    expect(split.preservedRecentTokens).toBe(countMessagesTokens(history.slice(4), MODEL));
    expect(summariseTokens).toBe(countMessagesTokens(history.slice(0, 4), MODEL));
    expect(summariseTokens).toBeGreaterThanOrEqual(MIN_SUMMARISE_TOKENS);
  });

  test('no user prompt at all: summarise everything, preserve nothing', () => {
    const history = Array.from({ length: 5 }, (_, index) => message('assistant', 70, `a${index}`));
    const before = plain(history);
    expect(before.summariseTokens).toBeLessThan(MIN_SUMMARISE_TOKENS);
    expect(before.split.preservedRecentMessages.length).toBeGreaterThan(0);

    const { split, summariseTokens } = planCompactionSplit(history, MODEL, NUM_CTX, 1);
    expect(split).toStrictEqual({
      messagesToSummarise: history,
      preservedRecentMessages: [],
      preservedRecentTokens: 0,
    });
    expect(summariseTokens).toBe(countMessagesTokens(history, MODEL));
  });

  test('the anchor is the first message and nothing is left to summarise: summarise everything', () => {
    const history = [
      message('user', 70, 'u1'),
      message('assistant', 20, 'a1'),
      message('assistant', 20, 'a2'),
      message('assistant', 20, 'a3'),
      message('assistant', 20, 'a4'),
    ];
    // The plain split keeps the anchor (the first message) and everything after
    // it as the preserved window, because the anchor is never summarised, and so
    // leaves nothing to summarise: this is the one case where the anchor is at
    // index 0 and the ladder still has something to do.
    const before = plain(history);
    expect(before.split.messagesToSummarise).toStrictEqual([]);
    expect(before.split.preservedRecentMessages.length).toBeGreaterThan(0);

    const { split, summariseTokens } = planCompactionSplit(history, MODEL, NUM_CTX, 1);
    expect(split).toStrictEqual({
      messagesToSummarise: history,
      preservedRecentMessages: [],
      preservedRecentTokens: 0,
    });
    // Still under the minimum, so the caller refuses it ("too short to compact").
    expect(summariseTokens).toBe(countMessagesTokens(history, MODEL));
    expect(summariseTokens).toBeLessThan(MIN_SUMMARISE_TOKENS);
  });

  test('a single message has nothing preserved, so the ladder does not run', () => {
    const history = [message('user', 10, 'only')];
    const { split, summariseTokens } = planCompactionSplit(history, MODEL, NUM_CTX, 1);
    expect(split).toStrictEqual({
      messagesToSummarise: history,
      preservedRecentMessages: [],
      preservedRecentTokens: 0,
    });
    expect(summariseTokens).toBe(countMessagesTokens(history, MODEL));
  });
});
