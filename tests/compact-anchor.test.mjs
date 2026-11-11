/**
 * Unit tests for the compaction pipeline's latest-user-message anchor.
 *
 * No network, no live server, no Ollama — the tests exercise the pure
 * functions in src/services/compact/split.ts.
 *
 * Regression focus: the anchor must never latch onto a server-generated
 * synthetic nudge (role 'user', content prefixed with SYNTHETIC_NUDGE_MARKER).
 * Before the fix, on a second auto-compaction within one turn the anchor
 * matched the LLM-only post-compaction nudge instead of the real user prompt,
 * so the real prompt was silently summarised away.
 */

import { describe, expect, test } from '@jest/globals';

import { SYNTHETIC_NUDGE_MARKER } from '../src/services/compact/constants.ts';
import { findLatestUserMessageIndex, isSyntheticNudge } from '../src/services/compact/split.ts';

describe('isSyntheticNudge', () => {
  test.each([
    [
      'user message with marker prefix is a synthetic nudge',
      { role: 'user', content: `${SYNTHETIC_NUDGE_MARKER}compacted...` },
      true,
    ],
    [
      'plain user message is not a synthetic nudge',
      { role: 'user', content: 'a real user prompt' },
      false,
    ],
    [
      'assistant message with marker is not a synthetic nudge',
      { role: 'assistant', content: `${SYNTHETIC_NUDGE_MARKER}compacted...` },
      false,
    ],
    [
      'marker-only content still counts as a synthetic nudge',
      { role: 'user', content: `${SYNTHETIC_NUDGE_MARKER}` },
      true,
    ],
    [
      'marker not at start does not mark a synthetic nudge',
      { role: 'user', content: `prefix${SYNTHETIC_NUDGE_MARKER}mid-text` },
      false,
    ],
    ['undefined message is not a synthetic nudge', undefined, false],
  ])('%s', (_label, input, expected) => {
    expect(isSyntheticNudge(input)).toBe(expected);
  });
});

describe('findLatestUserMessageIndex', () => {
  test('empty history returns -1', () => {
    expect(findLatestUserMessageIndex([])).toBe(-1);
  });
  test('single real user message is anchored', () => {
    expect(
      findLatestUserMessageIndex([
        { role: 'user', content: 'real prompt' },
        { role: 'assistant', content: 'answer' },
      ])
    ).toBe(0);
  });

  // The regression scenario: real prompt → assistant → post-compaction nudge.
  // The anchor must skip the nudge and pick the real prompt, so the prompt is
  // preserved verbatim instead of being summarised away on the next pass.
  const nudgedHistory = [
    { role: 'assistant', content: 'old assistant turn' },
    { role: 'user', content: 'fix the login bug' },
    { role: 'assistant', content: 'worked on it' },
    {
      role: 'user',
      content: `${SYNTHETIC_NUDGE_MARKER}The conversation history was automatically compacted...`,
    },
  ];
  test('anchor skips synthetic post-compaction nudge and returns the real prompt', () => {
    expect(findLatestUserMessageIndex(nudgedHistory)).toBe(1);
  });

  const nudgeOnlyHistory = [
    { role: 'user', content: `${SYNTHETIC_NUDGE_MARKER}compacted...` },
    { role: 'assistant', content: 'reply' },
  ];
  test('history containing only a synthetic nudge has no anchor', () => {
    expect(findLatestUserMessageIndex(nudgeOnlyHistory)).toBe(-1);
  });

  // Latest real prompt wins over an earlier synthetic nudge.
  const mixedHistory = [
    { role: 'user', content: `${SYNTHETIC_NUDGE_MARKER}older nudge` },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'newest real prompt' },
  ];
  test('newest real prompt is preferred over an older nudge', () => {
    expect(findLatestUserMessageIndex(mixedHistory)).toBe(2);
  });

  // Tool messages are ignored.
  const toolHistory = [
    { role: 'user', content: 'prompt' },
    {
      role: 'assistant',
      content: 'calling tool',
      tool_calls: [{ id: 't1', function: { name: 'x', arguments: '{}' } }],
    },
    { role: 'tool', content: 'result', tool_call_id: 't1' },
  ];
  test('tool messages are skipped when anchoring', () => {
    expect(findLatestUserMessageIndex(toolHistory)).toBe(0);
  });
});
