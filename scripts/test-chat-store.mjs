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

import { chatReducer, hasLiveTranscript, initialState } from '../src/app/lib/chatStore.ts';
import { routeSseEvent } from '../src/app/lib/sseRouting.ts';
import { createBatchedDispatcher } from '../src/app/lib/updateBatcher.ts';
import { appendSubagentLineText } from '../src/tools/toolOutput.ts';
import { createFakeClock } from './fakeClock.mjs';

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
    config: { activeSubagentId: 'research' },
  });
  state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 42, pending: true });
  state = chatReducer(state, {
    type: 'SET_STEER_DRAFT',
    sessionId: 42,
    draft: { id: 'd1', text: 'go on', target: 'main', copiesAtSend: 0 },
  });
  state = chatReducer(state, {
    type: 'RENAME_STREAMING',
    fromSessionId: -1,
    toSessionId: 42,
  });
  // A STOP followed by a START would leave the set momentarily empty; the
  // rename must leave all of this alone.
  assert.equal(state.activeSubagentId, 'research');
  assert.equal(state.modelSwitchPendingSessions.has(42), true);
  assert.equal(state.steerDrafts.get(42)?.id, 'd1');
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

// ── switching conversations while a turn streams ───────────────────────────
// The client used to hold a background session's events in a buffer and
// replay it on top of a fresh database copy when the user came back. The
// database already had part of what the buffer held, so text was doubled;
// what streamed in during the reload was lost; errors were never replayed;
// and the tool call still running was invisible. Now every event is applied
// to its own session as it arrives — these checks pin that a conversation
// the user leaves and comes back to ends up EXACTLY as if they never left.

/** Apply one SSE frame the way the chat-stream hook does, owned by `owner`. */
function applyFrame(state, event, data, owner) {
  const outcome = routeSseEvent(event, data, {
    targetSessionId: owner,
    approvalOwner: owner,
    compactOwner: owner,
    doneOwner: owner,
    subagentOwner: owner,
  });
  let next = state;
  for (const action of outcome.actions) next = chatReducer(next, action);
  if (outcome.subagentChunk) {
    // The hook coalesces these for 50 ms; the store action is the same.
    const { agentId, text } = outcome.subagentChunk;
    next = chatReducer(next, { type: 'SUBAGENT_CHUNK', agentId, text, targetSessionId: owner });
  }
  return next;
}

/** A turn with every kind of content a switch could disturb. */
const TURN = [
  ['status', { phase: 'responding', tokensUsed: 1200, tokenLimit: 32768 }],
  ['thinking', { content: 'Need to read it.' }],
  ['chunk', { content: 'Let me look. ' }],
  ['tool_call', { name: 'run_command', arguments: { command: 'ls' } }],
  ['approval_request', { requestId: 'req-1', toolName: 'run_command', args: { command: 'ls' } }],
  ['tool_result', { name: 'run_command', result: 'a.txt', duration: 4, toolCallId: 'c1' }],
  ['chunk', { content: 'First try' }],
  ['clear_assistant', {}],
  ['chunk', { content: 'Found a.txt.' }],
  ['tool_call', { name: 'run_subagents', arguments: { agents: [] } }],
  ['subagent_output', { agentId: 'researcher', message: 'starting' }],
  ['subagent_chunk', { agentId: 'researcher', text: 'half' }],
  ['clear_subagent', { agentId: 'researcher', content: 'starting' }],
  ['subagent_chunk', { agentId: 'researcher', text: '\nredone' }],
  ['compact_progress', { message: 'Compacting conversation...' }],
  ['error', { message: 'provider fell over' }],
];

/** The parts of a session the user sees. Message ids are random, so dropped. */
function visible(state) {
  return {
    messages: state.messages.map(({ id: _id, ...rest }) => rest),
    error: state.error,
    tokenStats: state.tokenStats,
    compactingPhases: state.compactingPhases,
    activeSubagentId: state.activeSubagentId,
    pendingCommand: state.pendingCommand,
    pendingApprovalId: state.pendingApprovalId,
  };
}

/** Session 7 on screen with a user prompt, its turn streaming. */
function startTurnIn7() {
  let state = chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 7 });
  state = chatReducer(state, { type: 'START_STREAMING', sessionId: 7 });
  return chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: { role: 'user', content: 'what is here?' },
    targetSessionId: 7,
  });
}

for (let leaveAt = 0; leaveAt <= TURN.length; leaveAt += 1) {
  check(`leaving after frame ${leaveAt} and coming back shows the same conversation`, () => {
    let stayed = startTurnIn7();
    for (const [event, data] of TURN) stayed = applyFrame(stayed, event, data, 7);

    let left = startTurnIn7();
    TURN.forEach(([event, data], index) => {
      if (index === leaveAt) left = chatReducer(left, { type: 'SET_CURRENT_SESSION', id: 9 });
      left = applyFrame(left, event, data, 7);
    });
    if (leaveAt === TURN.length) left = chatReducer(left, { type: 'SET_CURRENT_SESSION', id: 9 });
    left = chatReducer(left, { type: 'SET_CURRENT_SESSION', id: 7 });

    assert.deepEqual(visible(left), visible(stayed));
  });
}

check('a background turn never touches the conversation on screen', () => {
  let state = startTurnIn7();
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
  state = chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: { role: 'user', content: 'nine' },
    targetSessionId: 9,
  });
  const before = visible(state);
  for (const [event, data] of TURN) state = applyFrame(state, event, data, 7);
  assert.deepEqual(visible(state), before);
});

check('a background error waits in its own conversation', () => {
  let state = startTurnIn7();
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
  state = applyFrame(state, 'error', { message: 'provider fell over' }, 7);
  assert.equal(state.error, null);
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 7 });
  assert.equal(state.error, 'provider fell over');
});

check('a background approval does not pop up over another conversation', () => {
  let state = startTurnIn7();
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
  state = applyFrame(
    state,
    'approval_request',
    { requestId: 'req-1', toolName: 'run_command', args: { command: 'rm x' } },
    7
  );
  assert.equal(state.showApproval, false);
  assert.equal(state.pendingApprovalId, null);
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 7 });
  assert.equal(state.showApproval, true);
  assert.equal(state.pendingApprovalId, 'req-1');
});

check('a session with no approval never shows the new-chat mirror’s approval', () => {
  let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
  state = chatReducer(state, {
    type: 'SHOW_APPROVAL',
    command: { name: 'run_command', args: { command: 'ls' } },
    requestId: 'new-chat-req',
    targetSessionId: -1,
  });
  assert.equal(state.showApproval, true);
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
  assert.equal(state.showApproval, false);
  assert.equal(state.pendingApprovalId, null);
});

check('one conversation’s running sub-agent is not another’s steer target', () => {
  let state = startTurnIn7();
  state = applyFrame(state, 'subagent_output', { agentId: 'researcher', message: 'go' }, 7);
  assert.equal(state.activeSubagentId, 'researcher');
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
  assert.equal(state.activeSubagentId, null);
  state = applyFrame(state, 'subagent_chunk', { agentId: 'writer', text: 'x' }, 7);
  assert.equal(state.activeSubagentId, null);
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 7 });
  assert.equal(state.activeSubagentId, 'writer');
});

check('a turn ending clears only its own session’s sub-agent', () => {
  let state = startTurnIn7();
  state = chatReducer(state, { type: 'START_STREAMING', sessionId: 9 });
  state = applyFrame(state, 'subagent_output', { agentId: 'seven', message: 'go' }, 7);
  state = applyFrame(state, 'subagent_output', { agentId: 'nine', message: 'go' }, 9);
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 9 });
  assert.equal(state.activeSubagentId, 'seven');
  state = chatReducer(state, { type: 'START_STREAMING', sessionId: 9 });
  state = applyFrame(state, 'subagent_output', { agentId: 'nine', message: 'go' }, 9);
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 7 });
  assert.equal(state.activeSubagentId, null);
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
  assert.equal(state.activeSubagentId, 'nine');
});

check('a new chat’s early frames are on screen while the new-chat view is', () => {
  let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
  state = applyFrame(state, 'error', { message: 'no such model' }, -1);
  state = applyFrame(state, 'chunk', { content: 'hi' }, -1);
  assert.equal(state.error, 'no such model');
  assert.equal(state.messages.at(-1).content, 'hi');
  assert.equal(state.newSessionState.messages.length, 0);
});

check('a new chat left before it was saved keeps its transcript once it is', () => {
  let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
  state = chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: { role: 'user', content: 'opening prompt' },
    targetSessionId: -1,
  });
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
  state = applyFrame(state, 'chunk', { content: 'early ' }, -1);
  state = chatReducer(state, { type: 'RENAME_STREAMING', fromSessionId: -1, toSessionId: 12 });
  state = applyFrame(state, 'chunk', { content: 'reply' }, 12);
  assert.equal(state.newSessionState.messages.length, 0, 'the next New chat must open empty');
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 12 });
  assert.deepEqual(
    state.messages.map((m) => m.content),
    ['opening prompt', 'early reply']
  );
});

check('the new chat on screen keeps its transcript when the server saves it', () => {
  let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
  state = chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: { role: 'user', content: 'opening prompt' },
    targetSessionId: -1,
  });
  state = chatReducer(state, { type: 'RENAME_STREAMING', fromSessionId: -1, toSessionId: 12 });
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 12, adoptNewChat: true });
  assert.deepEqual(
    state.messages.map((m) => m.content),
    ['opening prompt']
  );
});

check('opening another session from the new-chat view does not take the new chat with it', () => {
  let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
  state = chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: { role: 'user', content: 'opening prompt' },
    targetSessionId: -1,
  });
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
  assert.deepEqual(state.messages, []);
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: null });
  assert.deepEqual(
    state.messages.map((m) => m.content),
    ['opening prompt']
  );
});

check('a streaming session the client tracks has a live transcript', () => {
  let state = startTurnIn7();
  assert.equal(hasLiveTranscript(state, 7), true, 'on screen');
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
  assert.equal(hasLiveTranscript(state, 7), true, 'in its slot');
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 7 });
  assert.equal(hasLiveTranscript(state, 7), false, 'finished: reload from the database');
  assert.equal(hasLiveTranscript(state, 9), false, 'never streamed');
});

// ── steering drafts, restore text and the model-switch flag ────────────────
// They used to be single app-wide fields. One conversation's pending steer
// locked every other conversation's steer box; an unacknowledged steer was
// put back in whichever composer mounted next (so it could land in a
// different conversation); and a steer the server had already saved itself
// (it does, when the turn ends before a tool step could pick it up) was put
// back as well, so sending it again duplicated it. All three are per
// conversation now, and the end of a turn compares the saved history before
// restoring anything.

const STEER_TEXT = 'make every fact shorter';
const steerDraft = (id, text = STEER_TEXT, copiesAtSend = 0) => ({
  id,
  text,
  target: 'main',
  copiesAtSend,
});
const userMessage = (content) => ({ role: 'user', content });

/** Sessions 5 (on screen) and 9 both streaming. */
function twoStreaming() {
  let state = chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 5 });
  state = chatReducer(state, { type: 'START_STREAMING', sessionId: 5 });
  return chatReducer(state, { type: 'START_STREAMING', sessionId: 9 });
}

check('a steering draft belongs to the session it was sent for', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 9, draft: steerDraft('d1') });
  assert.equal(state.steerDrafts.has(9), true);
  assert.equal(state.steerDrafts.has(5), false, 'the conversation on screen has no draft');
});

check('releasing a draft that does not exist changes nothing', () => {
  const state = twoStreaming();
  assert.equal(chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: null }), state);
});

check('a turn ending settles only ITS session’s draft', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: steerDraft('d5') });
  state = chatReducer(state, {
    type: 'SET_STEER_DRAFT',
    sessionId: 9,
    draft: steerDraft('d9', 'other'),
  });
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
  assert.equal(state.steerDrafts.has(5), false);
  assert.equal(state.steerDrafts.get(9)?.id, 'd9', 'the other conversation’s draft is untouched');
  assert.equal(state.steerRestoreTexts.has(9), false);
});

check('an unacknowledged steer that is not in the history is put back, for its own session', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'ADD_MESSAGE', message: userMessage('hello') });
  state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: steerDraft('d5') });
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
  assert.equal(state.steerRestoreTexts.get(5), STEER_TEXT);
  assert.equal(state.steerRestoreTexts.has(9), false, 'never filed under another conversation');
});

check('a steer the server already saved is NOT put back (conversation on screen)', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: steerDraft('d5') });
  // The turn's end reloads the transcript from the database before STOP: the
  // server saved the steer as a user message.
  state = chatReducer(state, { type: 'ADD_MESSAGE', message: userMessage(STEER_TEXT) });
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
  assert.equal(state.steerDrafts.has(5), false);
  assert.equal(state.steerRestoreTexts.has(5), false, 'it would be sent twice');
});

check('a steer the server already saved is NOT put back (conversation in the background)', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 9, draft: steerDraft('d9') });
  state = chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: userMessage(STEER_TEXT),
    targetSessionId: 9,
  });
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 9 });
  assert.equal(state.steerRestoreTexts.has(9), false);
  assert.equal(state.steerRestoreTexts.has(5), false);
});

check('an identical EARLIER message does not count as the saved steer', () => {
  let state = twoStreaming();
  // The transcript already held one copy when the steer was sent.
  state = chatReducer(state, { type: 'ADD_MESSAGE', message: userMessage(STEER_TEXT) });
  state = chatReducer(state, {
    type: 'SET_STEER_DRAFT',
    sessionId: 5,
    draft: steerDraft('d5', STEER_TEXT, 1),
  });
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
  assert.equal(
    state.steerRestoreTexts.get(5),
    STEER_TEXT,
    'still one copy: the steer was not saved'
  );
});

check('one MORE copy than before the steer counts as the saved steer', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'ADD_MESSAGE', message: userMessage(STEER_TEXT) });
  state = chatReducer(state, {
    type: 'SET_STEER_DRAFT',
    sessionId: 5,
    draft: steerDraft('d5', STEER_TEXT, 1),
  });
  state = chatReducer(state, { type: 'ADD_MESSAGE', message: userMessage(STEER_TEXT) });
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
  assert.equal(state.steerRestoreTexts.has(5), false);
});

check('an acknowledged draft has nothing left to settle', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: steerDraft('d5') });
  state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: null });
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
  assert.equal(state.steerRestoreTexts.has(5), false);
});

check('restored text stays with its conversation when the user switches', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: steerDraft('d5') });
  state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
  // The user is looking at 9; the text belongs to 5 and is filed under 5.
  assert.equal(state.steerRestoreTexts.get(5), STEER_TEXT);
  assert.equal(state.steerRestoreTexts.has(9), false);
  state = chatReducer(state, { type: 'CLEAR_STEER_RESTORE', sessionId: 9 });
  assert.equal(state.steerRestoreTexts.get(5), STEER_TEXT, 'clearing 9 leaves 5’s text alone');
  state = chatReducer(state, { type: 'CLEAR_STEER_RESTORE', sessionId: 5 });
  assert.equal(state.steerRestoreTexts.has(5), false);
});

check('a pending model switch belongs to its session', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 9, pending: true });
  assert.equal(state.modelSwitchPendingSessions.has(9), true);
  assert.equal(
    state.modelSwitchPendingSessions.has(5),
    false,
    'not pending on the conversation on screen'
  );
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
  assert.equal(
    state.modelSwitchPendingSessions.has(9),
    true,
    'another turn ending does not clear it'
  );
  state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 9 });
  assert.equal(
    state.modelSwitchPendingSessions.has(9),
    false,
    'a switch that never landed dies with its turn'
  );
});

check('a pending model switch is released by the confirmation for its session', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 5, pending: true });
  state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 9, pending: true });
  state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 9, pending: false });
  assert.deepEqual([...state.modelSwitchPendingSessions], [5]);
});

check('discarding a session drops its steer and switch state', () => {
  let state = twoStreaming();
  state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 9, draft: steerDraft('d9') });
  state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 9, pending: true });
  state = chatReducer(state, { type: 'DISCARD_SESSION', sessionId: 9 });
  assert.equal(state.steerDrafts.has(9), false);
  assert.equal(state.modelSwitchPendingSessions.has(9), false);
});

// ── the wiring the components must keep ────────────────────────────────────
// The components cannot run without React, so the source is read.
const readSource = (path) =>
  fs.readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const steerInputSource = readSource('../src/components/SteerInput/SteerInput.tsx');
const chatInputSource = readSource('../src/components/ChatInput/ChatInput.tsx');
const statusBarSource = readSource('../src/components/StatusBar/StatusBar.tsx');

check(
  'the steer box files its draft under the session it sent to, not the one on screen later',
  () => {
    assert.ok(steerInputSource.includes('sessionId: streamingSessionId'));
    assert.ok(steerInputSource.includes('copiesAtSend'));
    assert.ok(steerInputSource.includes('steerDrafts.has(streamingSessionId)'));
  }
);

check('the composer only takes the restore text of the conversation it shows', () => {
  assert.ok(chatInputSource.includes('state.steerRestoreTexts.get(state.currentSessionId)'));
  assert.ok(
    chatInputSource.includes("type: 'CLEAR_STEER_RESTORE', sessionId: state.currentSessionId")
  );
});

check('the status bar shows the pending switch of the conversation on screen only', () => {
  assert.ok(statusBarSource.includes('modelSwitchPendingSessions.has(currentSessionId)'));
});

// ── background updates go through the batched dispatcher ───────────────────
// The updates of a conversation that is not on screen are queued and applied
// together once per interval; every ordinary dispatch applies the queue first.
// These checks replay the SAME ordered actions two ways — one by one straight
// into the reducer, and through the dispatcher with the stream hook's rule
// (queue when the owner is not on screen, dispatch otherwise) — and require
// the same final state. Batching may change WHEN an update is applied, never
// the order, and a reload from the database must never be followed by older
// queued text.

const BATCH_INTERVAL = 1000;

/**
 * Replay a script of steps. A step is `{ frame: [event, data, owner] }` (routed
 * like the stream hook routes it), `{ action }` (a plain dispatch) or
 * `{ tick: ms }` (time passes). With `batched` false every action is applied
 * straight away.
 */
function play(script, { batched }) {
  let state = initialState;
  const clock = createFakeClock();
  const dispatcher = createBatchedDispatcher(
    (action) => {
      state = chatReducer(state, action);
    },
    { intervalMs: BATCH_INTERVAL, schedule: clock.schedule, cancel: clock.cancel }
  );
  const onScreen = () => state.currentSessionId ?? -1;
  const send = (action, owner) => {
    if (!batched) {
      state = chatReducer(state, action);
    } else if (owner !== undefined && owner !== onScreen()) {
      dispatcher.dispatchBackground(action);
    } else {
      dispatcher.dispatch(action);
    }
  };
  for (const step of script) {
    if (step.tick !== undefined) {
      clock.advance(step.tick);
    } else if (step.frame) {
      const [event, data, owner] = step.frame;
      const outcome = routeSseEvent(event, data, {
        targetSessionId: owner,
        approvalOwner: owner,
        compactOwner: owner,
        doneOwner: owner,
        subagentOwner: owner,
      });
      for (const action of outcome.actions) send(action, owner);
      if (outcome.subagentChunk) {
        const { agentId, text } = outcome.subagentChunk;
        send({ type: 'SUBAGENT_CHUNK', agentId, text, targetSessionId: owner }, owner);
      }
    } else {
      send(step.action, step.owner);
    }
  }
  dispatcher.flush();
  return state;
}

/** Every session's transcript, ids dropped (they are random). */
function transcripts(state) {
  const strip = (messages) => messages.map(({ id: _id, ...rest }) => rest);
  const out = { onScreen: strip(state.messages) };
  for (const [id, slot] of state.sessionStates) out[id] = strip(slot.messages);
  return out;
}

const turnScript = (leaveAt, { ticks }) => {
  const steps = [
    { action: { type: 'SET_CURRENT_SESSION', id: 7 } },
    { action: { type: 'START_STREAMING', sessionId: 7 } },
    {
      action: {
        type: 'ADD_MESSAGE',
        message: { role: 'user', content: 'what is here?' },
        targetSessionId: 7,
      },
      owner: 7,
    },
  ];
  TURN.forEach(([event, data], index) => {
    if (index === leaveAt) steps.push({ action: { type: 'SET_CURRENT_SESSION', id: 9 } });
    steps.push({ frame: [event, data, 7] });
    if (ticks && index % 4 === 3) steps.push({ tick: BATCH_INTERVAL });
  });
  if (leaveAt === TURN.length) steps.push({ action: { type: 'SET_CURRENT_SESSION', id: 9 } });
  steps.push({ action: { type: 'SET_CURRENT_SESSION', id: 7 } });
  return steps;
};

for (const ticks of [false, true]) {
  for (let leaveAt = 0; leaveAt <= TURN.length; leaveAt += 1) {
    check(
      `leaving after frame ${leaveAt} and coming back ends the same batched or not${ticks ? ' (with the timer firing along the way)' : ''}`,
      () => {
        const script = turnScript(leaveAt, { ticks });
        const batched = play(script, { batched: true });
        const direct = play(script, { batched: false });
        assert.deepEqual(visible(batched), visible(direct));
        assert.deepEqual(transcripts(batched), transcripts(direct));
      }
    );
  }
}

check('background updates are held back until the interval, then arrive together', () => {
  let state = chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 5 });
  state = chatReducer(state, { type: 'START_STREAMING', sessionId: 7 });
  const clock = createFakeClock();
  const dispatcher = createBatchedDispatcher(
    (action) => {
      state = chatReducer(state, action);
    },
    { intervalMs: BATCH_INTERVAL, schedule: clock.schedule, cancel: clock.cancel }
  );
  const slotText = () => state.sessionStates.get(7)?.messages.at(-1)?.content ?? '';
  for (const piece of ['one ', 'two ', 'three']) {
    dispatcher.dispatchBackground({
      type: 'APPLY_ASSISTANT_DELTA',
      content: piece,
      targetSessionId: 7,
    });
  }
  assert.equal(slotText(), '', 'nothing has been applied yet');
  clock.advance(BATCH_INTERVAL);
  assert.equal(slotText(), 'one two three');
});

check('a reload from the database is never followed by older queued text', () => {
  const dbMessages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'the final reply' },
    { role: 'user', content: STEER_TEXT },
  ];
  const script = [
    { action: { type: 'SET_CURRENT_SESSION', id: 5 } },
    { action: { type: 'START_STREAMING', sessionId: 5 } },
    { action: { type: 'START_STREAMING', sessionId: 7 } },
    { action: { type: 'SET_STEER_DRAFT', sessionId: 7, draft: steerDraft('d7') } },
    { frame: ['chunk', { content: 'the final ' }, 7] },
    { frame: ['chunk', { content: 'reply' }, 7] },
    // The turn ends: the transcript is reloaded from the database, then settled.
    {
      action: {
        type: 'SET_MESSAGES',
        messages: dbMessages,
        targetSessionId: 7,
        allowEmptyWhileStreaming: true,
      },
    },
    { action: { type: 'STOP_STREAMING', sessionId: 7 } },
  ];
  const batched = play(script, { batched: true });
  const direct = play(script, { batched: false });
  assert.deepEqual(transcripts(batched), transcripts(direct));
  assert.deepEqual(
    transcripts(batched)[7].map((m) => m.content),
    ['go', 'the final reply', STEER_TEXT],
    'the queued chunks must not be appended after the reload'
  );
  assert.equal(batched.steerRestoreTexts.has(7), false, 'the saved steer is not put back');
});

check('a new chat left before it was saved ends the same batched or not', () => {
  const script = [
    { action: { type: 'START_STREAMING', sessionId: -1 } },
    {
      action: {
        type: 'ADD_MESSAGE',
        message: { role: 'user', content: 'opening prompt' },
        targetSessionId: -1,
      },
      owner: -1,
    },
    { action: { type: 'SET_CURRENT_SESSION', id: 9 } },
    { frame: ['chunk', { content: 'early ' }, -1] },
    { frame: ['chunk', { content: 'text ' }, -1] },
    { action: { type: 'RENAME_STREAMING', fromSessionId: -1, toSessionId: 12 } },
    { frame: ['chunk', { content: 'reply' }, 12] },
    { action: { type: 'SET_CURRENT_SESSION', id: 12 } },
  ];
  const batched = play(script, { batched: true });
  const direct = play(script, { batched: false });
  assert.deepEqual(transcripts(batched), transcripts(direct));
  assert.deepEqual(
    batched.messages.map((m) => m.content),
    ['opening prompt', 'early text reply']
  );
  assert.equal(batched.newSessionState.messages.length, 0, 'the next New chat opens empty');
});

check(
  'a conversation that comes on screen while its update is queued still lands in the right place',
  () => {
    const script = [
      { action: { type: 'SET_CURRENT_SESSION', id: 5 } },
      { action: { type: 'START_STREAMING', sessionId: 7 } },
      { frame: ['chunk', { content: 'queued while 7 was in the background' }, 7] },
      { action: { type: 'SET_CURRENT_SESSION', id: 7 } },
      { frame: ['chunk', { content: ' and dispatched while on screen' }, 7] },
    ];
    const batched = play(script, { batched: true });
    assert.equal(
      batched.messages.at(-1).content,
      'queued while 7 was in the background and dispatched while on screen'
    );
    assert.deepEqual(transcripts(batched), transcripts(play(script, { batched: false })));
  }
);

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
