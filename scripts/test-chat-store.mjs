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
 *
 * The sub-agent bubbles are covered too: `CLEAR_SUBAGENT_CONTENT` REPLACES
 * the LAST `subagent_log` bubble of one agent with the text the server kept
 * (it is replaced, not removed — the re-issued turn keeps streaming into it)
 * and leaves every other agent's bubble alone. An agent with no bubble yet
 * but with text to keep gets one.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { chatReducer, initialState } from '../src/app/lib/chatStore.ts';
import { appendSubagentLineText } from '../src/tools/toolOutput.ts';

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

/** A sub-agent bubble: the role the streamed agent text lives in. */
const subagentLog = (content, subagentId) => ({ role: 'subagent_log', content, subagentId });

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

/** A state with two sub-agent bubbles (two different agents) on screen. */
function stateWithSubagentBubbles() {
  let state = chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 5 });
  state = chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: subagentLog('PARTIAL-ANSWER', 'research'),
  });
  state = chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: subagentLog('other agent', 'writer'),
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

// ── CLEAR_SUBAGENT_CONTENT ─────────────────────────────────────────────────
// A sub-agent's turn that failed with a transient provider error is
// re-issued, so the text the failed attempt streamed has to go — while the
// text of the agent's EARLIER turns stays. The server knows what remains and
// sends it with the event, so the bubble is REPLACED with that text (not
// emptied): the re-issued turn keeps streaming into the same bubble, and
// removing it would take the bubble the user is watching away.
check('clearing a sub-agent replaces its bubble with the text that remains', () => {
  const state = chatReducer(stateWithSubagentBubbles(), {
    type: 'CLEAR_SUBAGENT_CONTENT',
    agentId: 'research',
    content: 'EARLIER-TURN-TEXT',
  });
  assert.equal(state.messages[0].content, 'EARLIER-TURN-TEXT');
});

check('the replaced bubble is still there (replaced, not removed)', () => {
  const state = chatReducer(stateWithSubagentBubbles(), {
    type: 'CLEAR_SUBAGENT_CONTENT',
    agentId: 'research',
    content: 'EARLIER-TURN-TEXT',
  });
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0].role, 'subagent_log');
  assert.equal(state.messages[0].subagentId, 'research');
});

check('another agent’s bubble is untouched', () => {
  const state = chatReducer(stateWithSubagentBubbles(), {
    type: 'CLEAR_SUBAGENT_CONTENT',
    agentId: 'research',
    content: 'EARLIER-TURN-TEXT',
  });
  assert.equal(state.messages[1].content, 'other agent');
});

check('clearing an unknown agent with no text changes nothing', () => {
  const before = stateWithSubagentBubbles();
  const state = chatReducer(before, {
    type: 'CLEAR_SUBAGENT_CONTENT',
    agentId: 'nobody',
    content: '',
  });
  assert.equal(state.messages.length, before.messages.length);
  assert.equal(state.messages[0].content, 'PARTIAL-ANSWER');
  assert.equal(state.messages[1].content, 'other agent');
});

check('clearing an unknown agent with text creates its bubble', () => {
  // The server says there IS text that has to remain for that agent, so it
  // is created rather than dropped — otherwise the remaining text would be
  // lost from the transcript.
  const state = chatReducer(stateWithSubagentBubbles(), {
    type: 'CLEAR_SUBAGENT_CONTENT',
    agentId: 'nobody',
    content: 'EARLIER-TURN-TEXT',
  });
  assert.equal(state.messages.length, 3);
  assert.equal(state.messages[2].role, 'subagent_log');
  assert.equal(state.messages[2].subagentId, 'nobody');
  assert.equal(state.messages[2].content, 'EARLIER-TURN-TEXT');
});

check('the LAST bubble of that agent is the one that is replaced', () => {
  let state = stateWithSubagentBubbles();
  state = chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: subagentLog('SECOND BUBBLE', 'research'),
  });
  const cleared = chatReducer(state, {
    type: 'CLEAR_SUBAGENT_CONTENT',
    agentId: 'research',
    content: 'EARLIER-TURN-TEXT',
  });
  assert.equal(cleared.messages.length, 3);
  assert.equal(cleared.messages[2].content, 'EARLIER-TURN-TEXT');
  assert.equal(cleared.messages[0].content, 'PARTIAL-ANSWER');
});

check('a clear for another session replaces that session’s bubble only', () => {
  let state = stateWithSessions();
  state = chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: subagentLog('PARTIAL-ANSWER', 'research'),
    targetSessionId: 9,
  });
  const cleared = chatReducer(state, {
    type: 'CLEAR_SUBAGENT_CONTENT',
    agentId: 'research',
    content: 'EARLIER-TURN-TEXT',
    targetSessionId: 9,
  });
  const slot = cleared.sessionStates.get(9);
  assert.equal(slot?.messages.at(-1)?.content, 'EARLIER-TURN-TEXT');
  // The visible transcript is not touched by a clear aimed at another session.
  assert.equal(cleared.messages.length, state.messages.length);
  assert.equal(cleared.messages[0].content, 'visible');
});

check('a clear for another session creates the bubble in that session', () => {
  const state = stateWithSessions();
  const cleared = chatReducer(state, {
    type: 'CLEAR_SUBAGENT_CONTENT',
    agentId: 'research',
    content: 'EARLIER-TURN-TEXT',
    targetSessionId: 9,
  });
  const slot = cleared.sessionStates.get(9);
  // The slot already held the message `stateWithSessions` filed under it.
  assert.equal(slot?.messages.length, 2);
  assert.equal(slot?.messages.at(-1)?.subagentId, 'research');
  assert.equal(slot?.messages.at(-1)?.content, 'EARLIER-TURN-TEXT');
  // The visible transcript is untouched.
  assert.equal(cleared.messages.length, state.messages.length);
  assert.equal(cleared.messages[0].content, 'visible');
});

// ── SUBAGENT_OUTPUT / the server's copy of the same text ─────────────────
// The CLIENT's rule is the reference: a line is appended with a newline
// BETWEEN two entries and NONE before the first one, and a streamed chunk
// is appended raw.
//
// The server keeps its own copy of the same text (the bucket the persisted
// `subagent_log` row is built from), and the clear that drops a failed
// turn's output REPLACES the client's bubble with the server's copy — so the
// two copies have to be byte-identical at every point. The server used to
// append a trailing newline instead, which put the newline in a different
// place than the client did: the same characters in a different order, so
// the replacement visibly reordered the surviving text.
check('the first line is the bubble’s whole content (no leading newline)', () => {
  const state = chatReducer(initialState, {
    type: 'SUBAGENT_OUTPUT',
    agentId: 'research',
    message: 'FIRST-LINE',
  });
  assert.equal(state.messages.at(-1).content, 'FIRST-LINE');
});

check('a second line is separated by exactly one newline', () => {
  let state = chatReducer(initialState, {
    type: 'SUBAGENT_OUTPUT',
    agentId: 'research',
    message: 'FIRST-LINE',
  });
  state = chatReducer(state, {
    type: 'SUBAGENT_OUTPUT',
    agentId: 'research',
    message: 'SECOND-LINE',
  });
  assert.equal(state.messages.at(-1).content, 'FIRST-LINE\nSECOND-LINE');
});

check('the server’s transcript and the client’s bubble are byte-identical', () => {
  // The same writes, in the same order, through both sides.
  const writes = [
    { kind: 'chunk', text: 'TURN-ONE-TEXT' },
    { kind: 'line', message: '↻ Provider error (500) — retrying this turn (attempt 2/3).' },
    { kind: 'chunk', text: 'TURN-TWO-TEXT' },
    { kind: 'line', message: '⚠ Sub-agent stopped: the provider gave up.' },
  ];

  let state = initialState;
  let server = '';
  for (const write of writes) {
    if (write.kind === 'chunk') {
      state = chatReducer(state, {
        type: 'SUBAGENT_CHUNK',
        agentId: 'research',
        text: write.text,
      });
      server += write.text;
    } else {
      state = chatReducer(state, {
        type: 'SUBAGENT_OUTPUT',
        agentId: 'research',
        message: write.message,
      });
      server = appendSubagentLineText(server, write.message);
    }
  }

  assert.equal(state.messages.at(-1).content, server);
});

check('the clear’s replacement (the server’s copy) is the client’s bubble', () => {
  // The clear replaces the bubble with the text the server kept, so the
  // replacement must not change a single character.
  let state = initialState;
  state = chatReducer(state, { type: 'SUBAGENT_CHUNK', agentId: 'research', text: 'TURN-ONE' });
  state = chatReducer(state, {
    type: 'SUBAGENT_OUTPUT',
    agentId: 'research',
    message: '↻ Provider error',
  });
  const server = appendSubagentLineText('TURN-ONE', '↻ Provider error');
  const cleared = chatReducer(state, {
    type: 'CLEAR_SUBAGENT_CONTENT',
    agentId: 'research',
    content: server,
  });
  assert.equal(cleared.messages.at(-1).content, state.messages.at(-1).content);
});

// ── the ROUTE uses the shared helper ───────────────────────────────────────
// The chat route is a Next.js route handler, so a plain node script cannot
// import it. The source is read instead — the same trick the sub-agent
// compaction regression check uses — so the route cannot quietly go back to
// appending the newline in a different place than the client does.
const routeSource = fs.readFileSync(
  new URL('../src/app/api/chat/route.ts', import.meta.url),
  'utf8'
);

check('the route appends an agent line with the shared helper', () => {
  assert.ok(
    routeSource.includes('appendSubagentLineText('),
    'the route does not use the shared line-append helper'
  );
});

check('the route does not append a trailing newline any more', () => {
  assert.ok(
    !routeSource.includes('}${text}\\n'),
    'the route still appends the line with its own (different) rule'
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
