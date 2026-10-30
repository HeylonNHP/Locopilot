#!/usr/bin/env node
/**
 * Tests for the chat store's per-session routing (src/app/lib/chatStore.ts).
 *
 * Run with: npx tsx scripts/test-chat-store.mjs
 *
 * No network, no server, no React: the reducer is a pure function.
 *
 * Regression focus: every per-session action routes through `applyToSession`
 * so it lands in the right session's slot — except SET_MESSAGES, which used
 * to be dropped for any session that was not on screen. That made a turn
 * that finished in the background never reconcile its transcript. The rules
 * are now:
 *
 *   - the session on screen gets the top-level fields;
 *   - another session gets its own slot, and the visible one is untouched;
 *   - the placeholder (-1) is the visible transcript only while no session is
 *     selected, and is never written into `newSessionState` (which would leak
 *     the copy into whatever chat is started next).
 */

import assert from 'node:assert/strict';

import { chatReducer, initialState } from '../src/app/lib/chatStore.ts';

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

const message = (content, id = 'm1') => ({ role: 'assistant', content, id });

/** A state with a session selected and one other session's slot present. */
function stateWithSessions() {
  let state = initialState;
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 5 });
  state = chatReducer(state, { type: 'START_STREAMING', sessionId: 5 });
  state = chatReducer(state, { type: 'ADD_MESSAGE', message: message('visible') });
  state = chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: message('for nine'),
    targetSessionId: 9,
  });
  return state;
}

// ── SET_MESSAGES ───────────────────────────────────────────────────────────
check('a copy for the session on screen replaces its transcript', () => {
  const state = chatReducer(stateWithSessions(), {
    type: 'SET_MESSAGES',
    messages: [message('fresh')],
    targetSessionId: 5,
  });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].content, 'fresh');
});

check('a copy for another session lands in that session slot', () => {
  const state = chatReducer(stateWithSessions(), {
    type: 'SET_MESSAGES',
    messages: [message('for nine')],
    targetSessionId: 9,
  });
  const slot = state.sessionStates.get(9);
  assert.equal(slot?.messages.length, 1);
  assert.equal(slot?.messages[0].content, 'for nine');
});

check('a copy for another session leaves the visible one untouched', () => {
  const before = stateWithSessions();
  const state = chatReducer(before, {
    type: 'SET_MESSAGES',
    messages: [message('for nine')],
    targetSessionId: 9,
  });
  assert.equal(state.messages.length, before.messages.length);
  assert.equal(state.messages[0].content, before.messages[0].content);
});

check('the placeholder copy is the visible transcript while no session is selected', () => {
  const state = chatReducer(initialState, {
    type: 'SET_MESSAGES',
    messages: [message('for the new chat')],
    targetSessionId: -1,
  });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].content, 'for the new chat');
});

check('the placeholder copy is dropped when a real session is selected', () => {
  const state = chatReducer(stateWithSessions(), {
    type: 'SET_MESSAGES',
    messages: [message('for the new chat')],
    targetSessionId: -1,
  });
  // It must not reach newSessionState, which the next "New chat" would
  // render as that chat's transcript.
  assert.equal(state.newSessionState.messages.length, 0);
  assert.equal(state.messages[0].content, 'visible');
});

check('an empty copy does not wipe a streaming session', () => {
  const before = stateWithSessions();
  const state = chatReducer(before, {
    type: 'SET_MESSAGES',
    messages: [],
    targetSessionId: 5,
  });
  assert.equal(state.messages.length, before.messages.length);
});

check('an empty copy is applied when the session is not streaming', () => {
  const streaming = stateWithSessions();
  const idle = chatReducer(streaming, { type: 'STOP_STREAMING', sessionId: 5 });
  const state = chatReducer(idle, {
    type: 'SET_MESSAGES',
    messages: [],
    targetSessionId: 5,
  });
  assert.equal(state.messages.length, 0);
});

// ── RENAME_STREAMING ───────────────────────────────────────────────────────
check('renaming a streaming session moves it in one step', () => {
  let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
  state = chatReducer(state, {
    type: 'RENAME_STREAMING',
    fromSessionId: -1,
    toSessionId: 42,
  });
  assert.equal(state.streamingSessions.has(-1), false);
  assert.equal(state.streamingSessions.has(42), true);
  assert.equal(state.streamingSessions.size, 1);
});

check('renaming does not clear the steer state or the pending model switch', () => {
  let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
  state = chatReducer(state, {
    type: 'SET_CONFIG',
    config: { activeSubagentId: 'research', modelSwitchPending: true },
  });
  state = chatReducer(state, {
    type: 'RENAME_STREAMING',
    fromSessionId: -1,
    toSessionId: 42,
  });
  // A STOP followed by a START would leave the set momentarily empty, and an
  // empty set clears these.
  assert.equal(state.activeSubagentId, 'research');
  assert.equal(state.modelSwitchPending, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
