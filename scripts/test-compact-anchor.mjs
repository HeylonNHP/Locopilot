#!/usr/bin/env node
/**
 * Unit tests for the compaction pipeline's latest-user-message anchor.
 *
 * Run with: npx tsx scripts/test-compact-anchor.mjs
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

import { SYNTHETIC_NUDGE_MARKER } from '../src/services/compact/constants.ts';
import { findLatestUserMessageIndex, isSyntheticNudge } from '../src/services/compact/split.ts';

let pass = 0;
let fail = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected: ${expected}\n        actual:   ${actual}`);
    fail += 1;
  }
}

console.log('isSyntheticNudge');

assertEq(
  isSyntheticNudge({ role: 'user', content: `${SYNTHETIC_NUDGE_MARKER}compacted...` }),
  true,
  'user message with marker prefix is a synthetic nudge'
);
assertEq(
  isSyntheticNudge({ role: 'user', content: 'a real user prompt' }),
  false,
  'plain user message is not a synthetic nudge'
);
assertEq(
  isSyntheticNudge({ role: 'assistant', content: `${SYNTHETIC_NUDGE_MARKER}compacted...` }),
  false,
  'assistant message with marker is not a synthetic nudge'
);
assertEq(
  isSyntheticNudge({ role: 'user', content: `${SYNTHETIC_NUDGE_MARKER}` }),
  true,
  'marker-only content still counts as a synthetic nudge'
);
assertEq(
  isSyntheticNudge({ role: 'user', content: `prefix${SYNTHETIC_NUDGE_MARKER}mid-text` }),
  false,
  'marker not at start does not mark a synthetic nudge'
);
assertEq(isSyntheticNudge(undefined), false, 'undefined message is not a synthetic nudge');

console.log('findLatestUserMessageIndex');

assertEq(findLatestUserMessageIndex([]), -1, 'empty history returns -1');
assertEq(
  findLatestUserMessageIndex([
    { role: 'user', content: 'real prompt' },
    { role: 'assistant', content: 'answer' },
  ]),
  0,
  'single real user message is anchored'
);

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
assertEq(
  findLatestUserMessageIndex(nudgedHistory),
  1,
  'anchor skips synthetic post-compaction nudge and returns the real prompt'
);

const nudgeOnlyHistory = [
  { role: 'user', content: `${SYNTHETIC_NUDGE_MARKER}compacted...` },
  { role: 'assistant', content: 'reply' },
];
assertEq(
  findLatestUserMessageIndex(nudgeOnlyHistory),
  -1,
  'history containing only a synthetic nudge has no anchor'
);

// Latest real prompt wins over an earlier synthetic nudge.
const mixedHistory = [
  { role: 'user', content: `${SYNTHETIC_NUDGE_MARKER}older nudge` },
  { role: 'assistant', content: 'reply' },
  { role: 'user', content: 'newest real prompt' },
];
assertEq(
  findLatestUserMessageIndex(mixedHistory),
  2,
  'newest real prompt is preferred over an older nudge'
);

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
assertEq(findLatestUserMessageIndex(toolHistory), 0, 'tool messages are skipped when anchoring');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
