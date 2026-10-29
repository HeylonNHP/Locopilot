#!/usr/bin/env node
/**
 * Tests for the SSE event classification (src/app/lib/sseEvents.ts).
 *
 * Run with: npx tsx scripts/test-sse-events.mjs
 *
 * No network, no server, no React.
 *
 * Regression focus: the replay set used to be a hand-written `Set` of event
 * names in the chat-stream hook. It was replaced by a table that classifies
 * every event the server can send — which only helps if the table is
 * complete and if the replayable set is exactly what it was. These tests
 * pin both, against the canonical event list in `src/services/sseNames.ts`.
 */

import assert from 'node:assert/strict';

import {
  classifySseEvent,
  isReplayableEvent,
  SSE_EVENT_CLASSES,
} from '../src/app/lib/sseEvents.ts';
import { SSE_EVENT_NAMES } from '../src/services/sseNames.ts';

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message.split('\n').join('\n        ')}`);
    fail += 1;
  }
}

/**
 * The events the client replays when the user returns to a session it was
 * away from. This list is the behaviour the hand-written `Set` had; it is
 * pinned here so the classification table cannot quietly change it.
 */
const REPLAYED = [
  'chunk',
  'thinking',
  'tool_progress',
  'subagent_chunk',
  'status',
  'compact_progress',
  'done',
  'approval_request',
];

/**
 * The events the server has already written to the database. Replaying them
 * would duplicate what the reload from the database brings back.
 */
const PERSISTED = ['tool_call', 'tool_result', 'subagent_output', 'compact'];

check('every event the server can send is classified', () => {
  for (const name of SSE_EVENT_NAMES) {
    assert.notEqual(classifySseEvent(name), 'unknown', `${name} is not classified`);
  }
});

check('the classification table has no events the server cannot send', () => {
  assert.deepEqual(Object.keys(SSE_EVENT_CLASSES).sort(), [...SSE_EVENT_NAMES].sort());
});

check('exactly the replayable events are replayed', () => {
  const replayed = SSE_EVENT_NAMES.filter((name) => isReplayableEvent(name)).sort();
  assert.deepEqual(replayed, [...REPLAYED].sort());
});

check('the persisted events are not replayed', () => {
  for (const name of PERSISTED) {
    assert.equal(isReplayableEvent(name), false, `${name} must not be replayed`);
    assert.equal(classifySseEvent(name), 'persisted');
  }
});

check('the session and terminal events are meta, not replayed', () => {
  for (const name of ['session_created', 'error', 'write_error', 'clear_assistant']) {
    assert.equal(classifySseEvent(name), 'meta', `${name} should be meta`);
    assert.equal(isReplayableEvent(name), false);
  }
});

check('an unknown event is ignored rather than replayed', () => {
  assert.equal(classifySseEvent('something_new'), 'unknown');
  assert.equal(isReplayableEvent('something_new'), false);
});

check('an inherited property name is not an event', () => {
  // `in` walks the prototype chain, so 'toString' or 'constructor' would
  // resolve to a function instead of 'unknown'.
  for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.equal(classifySseEvent(name), 'unknown', `${name} must not classify`);
    assert.equal(isReplayableEvent(name), false);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
