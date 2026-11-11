/**
 * Unit tests for the shared empty-response recovery policy
 * (src/services/emptyResponseRecovery.ts).
 *
 * No network, no live server, no Ollama — the tests exercise the pure
 * functions and the tracker class directly.
 *
 * Regression focus: the sub-agent loop previously ended silently on an empty
 * model response (no retry), while the main chat loop had its own private
 * copy of the same policy. Both loops now share this module; these tests
 * pin the shared behaviour — detection rules, attempt cap, reset rules, and
 * the synthetic-marker-prefixed nudge text.
 */

import { describe, expect, test } from '@jest/globals';

import { SYNTHETIC_NUDGE_END, SYNTHETIC_NUDGE_MARKER } from '../src/services/compact/constants.ts';
import {
  buildEmptyResponseRecoveryNudge,
  EmptyResponseRecoveryTracker,
  hasMeaningfulAssistantContent,
  MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS,
  sanitizeAssistantTextFragment,
} from '../src/services/emptyResponseRecovery.ts';

describe('hasMeaningfulAssistantContent', () => {
  test.each([
    ['empty string is not meaningful', { role: 'assistant', content: '' }, false],
    [
      'whitespace-only content is not meaningful',
      { role: 'assistant', content: '   \n\t ' },
      false,
    ],
    ['undefined content is not meaningful', { role: 'assistant', content: undefined }, false],
    ['bare channel label is not meaningful', { role: 'assistant', content: 'thought' }, false],
    [
      'channel label with padding/case is not meaningful',
      { role: 'assistant', content: '  Analysis ' },
      false,
    ],
    [
      'plain text reply is meaningful',
      { role: 'assistant', content: 'The current temperature is 24C.' },
      true,
    ],
    [
      'channel label followed by real text is meaningful',
      { role: 'assistant', content: 'thought\nThe temperature is 24C.' },
      true,
    ],
  ])('%s', (_label, input, expected) => {
    expect(hasMeaningfulAssistantContent(input)).toBe(expected);
  });
});

describe('sanitizeAssistantTextFragment', () => {
  test('channel-label-only text is blanked', () => {
    expect(sanitizeAssistantTextFragment('thought')).toBe('');
  });
  test('ordinary text passes through untrimmed', () => {
    expect(sanitizeAssistantTextFragment('  hello  ')).toBe('  hello  ');
  });
});

describe('EmptyResponseRecoveryTracker', () => {
  test('a fresh tracker allows recovery and has used no attempts', () => {
    const tracker = new EmptyResponseRecoveryTracker();
    expect(tracker.shouldRecover()).toBe(true);
    expect(tracker.attemptsUsed).toBe(0);
  });

  test('one attempt still allows recovery', () => {
    const tracker = new EmptyResponseRecoveryTracker();
    tracker.recordAttempt();
    expect(tracker.shouldRecover()).toBe(true);
    expect(tracker.attemptsUsed).toBe(1);
  });

  test(`recovery is exhausted after ${MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS} attempts`, () => {
    const tracker = new EmptyResponseRecoveryTracker();
    for (let attempt = 0; attempt < MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS; attempt += 1) {
      tracker.recordAttempt();
    }
    expect(tracker.shouldRecover()).toBe(false);
    expect(tracker.attemptsUsed).toBe(MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS);
  });

  test('a reset re-enables recovery and clears the counter', () => {
    const tracker = new EmptyResponseRecoveryTracker();
    for (let attempt = 0; attempt < MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS; attempt += 1) {
      tracker.recordAttempt();
    }
    tracker.reset();
    expect(tracker.shouldRecover()).toBe(true);
    expect(tracker.attemptsUsed).toBe(0);
  });
});

describe('buildEmptyResponseRecoveryNudge', () => {
  test('is a user-role message, marked so that the compaction anchor skips it', () => {
    const nudge = buildEmptyResponseRecoveryNudge();
    expect(nudge.role).toBe('user');
    expect(nudge.content.startsWith(SYNTHETIC_NUDGE_MARKER)).toBe(true);
    expect(nudge.content.endsWith(SYNTHETIC_NUDGE_END)).toBe(true);
  });

  test('states that the response was empty', () => {
    expect(buildEmptyResponseRecoveryNudge().content).toContain('Your last response was empty');
  });

  test('is deterministic, and each call returns a fresh object', () => {
    const first = buildEmptyResponseRecoveryNudge();
    const second = buildEmptyResponseRecoveryNudge();
    // no shared mutable state
    expect(first).not.toBe(second);
    expect(second.content).toBe(first.content);
  });
});
