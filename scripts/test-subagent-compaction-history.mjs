#!/usr/bin/env node
/**
 * Regression guard: a sub-agent must not lose its system prompt to compaction.
 *
 * Run with: npx tsx scripts/test-subagent-compaction-history.mjs
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applySubAgentCompaction } from '../src/tools/impl/subAgentTool.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const subAgentSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'tools', 'impl', 'subAgentTool.ts'),
  'utf8'
);

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err instanceof Error ? err.message : String(err)}`);
    fail += 1;
  }
}

// ── Fixtures ─────────────────────────────────────────────────

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

console.log('applySubAgentCompaction');

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

check('the rebuilt history leads with the system prompt', () => {
  const { messages } = results.restored;
  assert.equal(messages[0], SYSTEM, 'index 0 must be the original system message object');
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, SYSTEM.content);
});

check('the orchestrator prompt stays verbatim at index 1', () => {
  const { messages } = results.restored;
  assert.equal(messages[1], TASK, 'index 1 must be the original orchestrator prompt object');
  assert.equal(messages[1].content, TASK.content);
});

check('a task copy that survived compaction is not duplicated', () => {
  const { messages } = results.taskCopy;
  const taskLike = messages.filter((m) => m.role === 'user' && m.content === TASK.content);
  assert.equal(taskLike.length, 1, `expected exactly one task message, got ${taskLike.length}`);
  assert.equal(messages[1], TASK, 'the verbatim task must be the one kept');
});

check('a mid-run steering message survives instead of being overwritten', () => {
  const { messages } = results.steerSurvives;
  assert.equal(messages[1], TASK);
  assert.ok(messages.includes(STEER), 'the steering message must survive');
  assert.ok(messages.indexOf(STEER) > messages.indexOf(TASK), 'steering stays after the task');
});

check('no other message is dropped', () => {
  const { messages } = results.restored;
  assert.equal(messages.length, 2 + (COMPACTED.length - 1), 'system + task + the rest');
  assert.ok(messages.includes(SUMMARY), 'the summary must survive');
  assert.ok(messages.includes(TOOL), 'the tool result must survive');
});

check('the history carries exactly one system message, and it is first', () => {
  const { messages } = results.straySystem;
  assert.equal(messages.filter((m) => m.role === 'system').length, 1);
  assert.equal(messages[0], SYSTEM);
});

check('a history with no system message still leads with the task', () => {
  const { messages } = results.noSystem;
  assert.equal(messages[0], TASK);
  assert.equal(messages.length, 3);
});

check('the compactor is handed the history it was given (capture happens first)', () => {
  assert.equal(results.restored.seenHistory, FULL_HISTORY);
  // The system message must have been captured before the compactor ran, i.e.
  // the rebuilt array still has it after the compactor returned a history
  // without one.
  assert.equal(results.restored.messages[0], SYSTEM);
});

check('the compaction token count is passed through for the overflow warning', () => {
  assert.equal(results.restored.newTokenCount, STUB_TOKEN_COUNT);
});

// ── Non-vacuity: the OLD algorithm must fail these properties ─────

console.log('non-vacuity (the previous implementation)');

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

check('the old splice dropped the system prompt — so this guard is not vacuous', () => {
  const old = oldImplementation(COMPACTED);
  assert.notEqual(old[0].role, 'system', 'the old implementation really did drop it');
  assert.equal(old.filter((m) => m.role === 'system').length, 0);
  // …and the real function satisfies the property the old one broke.
  assert.equal(results.restored.messages[0].role, 'system');
});

check('the old index-1 replace destroyed a steering message', () => {
  const old = oldImplementation([SUMMARY, STEER, TOOL]);
  assert.equal(old.includes(STEER), false, 'the old implementation really did drop it');
  assert.equal(results.steerSurvives.messages.includes(STEER), true);
});

// ── Source wiring (autoCompactSubAgentIfNeeded is private) ────

console.log('source wiring');

check('the compaction path rebuilds through applySubAgentCompaction', () => {
  const callSites = subAgentSource.split('applySubAgentCompaction(').length - 1;
  assert.equal(callSites, 2, 'expected the definition plus exactly one call site');
  assert.ok(
    subAgentSource.includes('messages.splice(0, messages.length, ...rebuiltMessages)'),
    'the rebuilt array must be what replaces the history'
  );
});

check('the raw splice of the compaction result has not come back', () => {
  assert.equal(
    subAgentSource.includes('messages.splice(0, messages.length, ...result.newMessages)'),
    false,
    'the unfixed splice must not reappear'
  );
});

check('the system prompt is captured before the compactor is awaited', () => {
  const captureAt = subAgentSource.indexOf("const systemMessage = messages[0]?.role === 'system'");
  const compactAt = subAgentSource.indexOf('const result = await compact(messages);');
  assert.ok(captureAt !== -1, 'expected the capture inside the rebuild function');
  assert.ok(compactAt !== -1, 'expected the injected compactor call');
  assert.ok(captureAt < compactAt, 'the capture must precede the await — otherwise it is too late');
});

// ── Report ───────────────────────────────────────────────────

console.log('');
if (fail > 0) {
  console.error(`${fail} check(s) failed, ${pass} passed.`);
  process.exitCode = 1;
} else {
  console.log(`All ${pass} checks passed.`);
}
