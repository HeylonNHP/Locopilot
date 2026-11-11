/**
 * Regression guard: a sub-agent must not lose its system prompt to compaction.
 *
 * Why this exists: `compactHistory` strips every `system` message by design —
 * its own comment says the system prompt "is injected on-the-fly by the caller".
 * The main chat route honours that (it re-prepends its preserved system message
 * and throws if there isn't one), but the sub-agent path spliced the compacted
 * history straight over its array. Index 0 therefore became the assistant
 * summary, and after ONE compaction the agent ran the whole rest of its life
 * with no system prompt at all: no role, no "return one concise self-contained
 * summary" contract, no citation directive, no shared time-interpretation rule.
 *
 * These checks drive the REAL `applySubAgentCompaction` — the exact function the
 * compaction path executes — with a stub compactor, so the behavioural
 * assertions fail if the rebuild logic regresses (not just the source text).
 * They also reconstruct the OLD algorithm and assert it fails the same
 * properties, so the guard cannot be vacuous.
 *
 * Network-free: no LLM, no filesystem writes.
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applySubAgentCompaction } from '../src/tools/impl/subAgentTool.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const subAgentSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'tools', 'impl', 'subAgentTool.ts'),
  'utf8'
);

// Fixtures

const SYSTEM = {
  role: 'system',
  content: 'You are a focused sub-agent running inside Locopilot. Return one concise summary.',
};
const TASK = { role: 'user', content: 'Summarise the docs under /docs' };
const STEER = { role: 'user', content: 'also check the changelog' };
const SUMMARY = {
  role: 'assistant',
  content: 'The conversation so far: the agent read three files.',
};
const TOOL = { role: 'tool', content: 'file contents', tool_call_id: 'call_1' };

// What a real compaction result looks like: an assistant summary first, then the
// preserved recent window, and NO system message — that is the whole problem.
const COMPACTED = [SUMMARY, TASK, TOOL];
const STUB_TOKEN_COUNT = 4242;

/** Drive the real function with a stub compactor that mimics `compactHistory`. */
async function applyCompaction(history, compacted = COMPACTED, newTokenCount = STUB_TOKEN_COUNT) {
  let seenHistory;
  const result = await applySubAgentCompaction(history, TASK, async (received) => {
    seenHistory = received;
    return { newMessages: compacted, newTokenCount };
  });
  return { ...result, seenHistory };
}

const FULL_HISTORY = [SYSTEM, TASK, TOOL];

// ── The invariant ────────────────────────────────────────────

const results = {
  restored: await applyCompaction(FULL_HISTORY),
  steerSurvives: await applyCompaction(FULL_HISTORY, [SUMMARY, STEER, TOOL]),
  taskCopy: await applyCompaction(FULL_HISTORY, [SUMMARY, { ...TASK }, TOOL]),
  straySystem: await applyCompaction(FULL_HISTORY, [
    SUMMARY,
    { role: 'system', content: 'x' },
    TOOL,
  ]),
  noSystem: await applyCompaction([TASK, TOOL], [SUMMARY, TOOL]),
};

describe('applySubAgentCompaction', () => {
  test('the rebuilt history leads with the system prompt', () => {
    const { messages } = results.restored;
    expect(messages[0]).toBe(SYSTEM);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(SYSTEM.content);
  });

  test('the orchestrator prompt stays verbatim at index 1', () => {
    const { messages } = results.restored;
    expect(messages[1]).toBe(TASK);
    expect(messages[1].content).toBe(TASK.content);
  });

  test('a task copy that survived compaction is not duplicated', () => {
    const { messages } = results.taskCopy;
    const taskLike = messages.filter((m) => m.role === 'user' && m.content === TASK.content);
    expect(taskLike).toHaveLength(1);
    expect(messages[1]).toBe(TASK);
  });

  test('a mid-run steering message survives instead of being overwritten', () => {
    const { messages } = results.steerSurvives;
    expect(messages[1]).toBe(TASK);
    expect(messages).toContain(STEER);
    expect(messages.indexOf(STEER)).toBeGreaterThan(messages.indexOf(TASK));
  });

  test('no other message is dropped', () => {
    const { messages } = results.restored;
    expect(messages).toHaveLength(2 + (COMPACTED.length - 1));
    expect(messages).toContain(SUMMARY);
    expect(messages).toContain(TOOL);
  });

  test('the history carries exactly one system message, and it is first', () => {
    const { messages } = results.straySystem;
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(messages[0]).toBe(SYSTEM);
  });

  test('a history with no system message still leads with the task', () => {
    const { messages } = results.noSystem;
    expect(messages[0]).toBe(TASK);
    expect(messages).toHaveLength(3);
  });

  test('the compactor is handed the history it was given (capture happens first)', () => {
    expect(results.restored.seenHistory).toBe(FULL_HISTORY);
    // The system message must have been captured before the compactor ran, i.e.
    // the rebuilt array still has it after the compactor returned a history
    // without one.
    expect(results.restored.messages[0]).toBe(SYSTEM);
  });

  test('the compaction token count is passed through for the overflow warning', () => {
    expect(results.restored.newTokenCount).toBe(STUB_TOKEN_COUNT);
  });
});

describe('non-vacuity (the previous implementation)', () => {
  /** Verbatim reconstruction of the removed logic. */
  function oldImplementation(compacted) {
    const next = [...compacted];
    if (next.length > 1 && next[1]?.role === 'user') {
      next[1] = TASK;
    } else {
      next.splice(1, 0, TASK);
    }
    return next;
  }

  test('the old splice dropped the system prompt — so this guard is not vacuous', () => {
    const old = oldImplementation(COMPACTED);
    expect(old[0].role).not.toBe('system');
    expect(old.filter((m) => m.role === 'system')).toHaveLength(0);
    // …and the real function satisfies the property the old one broke.
    expect(results.restored.messages[0].role).toBe('system');
  });

  test('the old index-1 replace destroyed a steering message', () => {
    const old = oldImplementation([SUMMARY, STEER, TOOL]);
    expect(old.includes(STEER)).toBe(false);
    expect(results.steerSurvives.messages.includes(STEER)).toBe(true);
  });
});

describe('source wiring', () => {
  test('the compaction path rebuilds through applySubAgentCompaction', () => {
    const callSites = subAgentSource.split('applySubAgentCompaction(').length - 1;
    expect(callSites).toBe(2);
    expect(subAgentSource).toContain('messages.splice(0, messages.length, ...rebuiltMessages)');
  });

  test('the raw splice of the compaction result has not come back', () => {
    expect(
      subAgentSource.includes('messages.splice(0, messages.length, ...result.newMessages)')
    ).toBe(false);
  });

  test('the system prompt is captured before the compactor is awaited', () => {
    const captureAt = subAgentSource.indexOf(
      "const systemMessage = messages[0]?.role === 'system'"
    );
    const compactAt = subAgentSource.indexOf('const result = await compact(messages);');
    expect(captureAt).not.toBe(-1);
    expect(compactAt).not.toBe(-1);
    expect(captureAt).toBeLessThan(compactAt);
  });
});

// Report
