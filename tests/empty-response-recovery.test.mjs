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
  MAX_RECOVERY_NUDGE_TOOL_NAMES,
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
  const TOOLS = ['run_command', 'web_search', 'read_file'];

  test('is a user-role message, marked so that the compaction anchor skips it', () => {
    const nudge = buildEmptyResponseRecoveryNudge(TOOLS);
    expect(nudge.role).toBe('user');
    expect(nudge.content.startsWith(SYNTHETIC_NUDGE_MARKER)).toBe(true);
    expect(nudge.content.endsWith(SYNTHETIC_NUDGE_END)).toBe(true);
  });

  test('states that the response was empty', () => {
    expect(buildEmptyResponseRecoveryNudge(TOOLS).content).toContain(
      'Your last response was empty'
    );
  });

  test('leads with the tool call, not with an instruction to answer in prose', () => {
    const content = buildEmptyResponseRecoveryNudge(TOOLS).content;
    // The old wording ("Provide a direct answer now") read to a model as
    // "stop calling tools and write prose" - it then narrated the call
    // ("I'll run a quick live check now") and never called anything.
    expect(content).not.toContain('Provide a direct answer');
    expect(content).not.toContain('summarize their output and errors');
    expect(content).toContain('call the tool now');
  });

  test('names the exact tools available this turn', () => {
    const content = buildEmptyResponseRecoveryNudge(TOOLS).content;
    for (const name of TOOLS) {
      expect(content).toContain(name);
    }
  });

  test('a name that is not one of the given tools is never listed', () => {
    const content = buildEmptyResponseRecoveryNudge(['run_command']).content;
    expect(content).not.toContain('web_search');
  });

  test('duplicate names are listed once', () => {
    const content = buildEmptyResponseRecoveryNudge(['run_command', 'run_command']).content;
    expect(content.match(/run_command/g)).toHaveLength(1);
  });

  test('a long tool list is capped and says how many names were left out', () => {
    const many = Array.from({ length: MAX_RECOVERY_NUDGE_TOOL_NAMES + 5 }, (_, i) => `tool_${i}`);
    const content = buildEmptyResponseRecoveryNudge(many).content;
    expect(content).toContain('tool_0');
    expect(content).not.toContain(`tool_${MAX_RECOVERY_NUDGE_TOOL_NAMES}`);
    expect(content).toContain('(+5 more)');
  });

  test('with no tools available it asks for an answer instead of a call', () => {
    const content = buildEmptyResponseRecoveryNudge([]).content;
    expect(content).not.toContain('call the tool now');
    expect(content).toContain('No tool is available');
  });

  test('is deterministic, and each call returns a fresh object', () => {
    const first = buildEmptyResponseRecoveryNudge(TOOLS);
    const second = buildEmptyResponseRecoveryNudge(TOOLS);
    // no shared mutable state
    expect(first).not.toBe(second);
    expect(second.content).toBe(first.content);
  });
});
