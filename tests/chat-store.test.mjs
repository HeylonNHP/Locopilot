/**
 * Tests for the chat store's per-session routing (src/app/lib/chatStore.ts).
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
 * The sub-agent traces are covered too. A trace lives on the tool message of
 * the CALL that started the agent (`subagentTraces`), found by the call id, so
 * an agent id that comes back in a later call starts a trace of its own.
 * `CLEAR_SUBAGENT_CONTENT` REPLACES one agent's trace with the text the server
 * kept (replaced, not removed — the re-issued turn keeps streaming into it) and
 * leaves every other agent's trace alone. An agent with no trace yet but with
 * text to keep gets one.
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';

import { chatReducer, hasLiveTranscript, initialState } from '../src/app/lib/chatStore.ts';
import { routeSseEvent } from '../src/app/lib/sseRouting.ts';
import { createBatchedDispatcher } from '../src/app/lib/updateBatcher.ts';
import { SubagentTraceBook } from '../src/services/subagentTraces.ts';
import { appendSubagentLineText } from '../src/tools/toolOutput.ts';
import { createFakeClock } from './helpers/fakeClock.mjs';

const message = (content, id = 'm1') => ({ role: 'assistant', content, id });

/** The live 🔧 card of a `run_subagents` call: what the sub-agent events attach to. */
const callCard = (toolCallId, subagentTraces) => ({
  role: 'tool',
  content: '🔧 **run_subagents**',
  name: 'run_subagents',
  toolCallId,
  ...(subagentTraces === undefined ? {} : { subagentTraces }),
});

/** One agent's trace. */
const trace = (agentId, content) => ({ agentId, content });

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

/** A state with one call card on screen, holding the traces of two different agents. */
function stateWithTraces() {
  const state = chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 5 });
  return chatReducer(state, {
    type: 'ADD_MESSAGE',
    message: callCard('call-1', [
      trace('research', 'PARTIAL-ANSWER'),
      trace('writer', 'other agent'),
    ]),
  });
}

/** The traces of the (only) call card of a state. */
const tracesOf = (state) => state.messages.at(-1).subagentTraces;

describe('SET_MESSAGES', () => {
  test('a copy for the session on screen replaces its transcript', () => {
    const state = chatReducer(stateWithSessions(), {
      type: 'SET_MESSAGES',
      messages: [message('fresh')],
      targetSessionId: 5,
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('fresh');
  });

  test('a copy for another session lands in that session slot', () => {
    const state = chatReducer(stateWithSessions(), {
      type: 'SET_MESSAGES',
      messages: [message('for nine')],
      targetSessionId: 9,
    });
    const slot = state.sessionStates.get(9);
    expect(slot?.messages).toHaveLength(1);
    expect(slot?.messages[0].content).toBe('for nine');
  });

  test('a copy for another session leaves the visible one untouched', () => {
    const before = stateWithSessions();
    const state = chatReducer(before, {
      type: 'SET_MESSAGES',
      messages: [message('for nine')],
      targetSessionId: 9,
    });
    expect(state.messages.length).toBe(before.messages.length);
    expect(state.messages[0].content).toBe(before.messages[0].content);
  });

  test('the placeholder copy is the visible transcript while no session is selected', () => {
    const state = chatReducer(initialState, {
      type: 'SET_MESSAGES',
      messages: [message('for the new chat')],
      targetSessionId: -1,
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('for the new chat');
  });

  test('the placeholder copy is dropped when a real session is selected', () => {
    const state = chatReducer(stateWithSessions(), {
      type: 'SET_MESSAGES',
      messages: [message('for the new chat')],
      targetSessionId: -1,
    });
    // It must not reach newSessionState, which the next "New chat" would
    // render as that chat's transcript.
    expect(state.newSessionState.messages).toHaveLength(0);
    expect(state.messages[0].content).toBe('visible');
  });

  test('an empty copy does not wipe a streaming session', () => {
    const before = stateWithSessions();
    const state = chatReducer(before, {
      type: 'SET_MESSAGES',
      messages: [],
      targetSessionId: 5,
    });
    expect(state.messages.length).toBe(before.messages.length);
  });

  test('an empty copy is applied when the session is not streaming', () => {
    const streaming = stateWithSessions();
    const idle = chatReducer(streaming, { type: 'STOP_STREAMING', sessionId: 5 });
    const state = chatReducer(idle, {
      type: 'SET_MESSAGES',
      messages: [],
      targetSessionId: 5,
    });
    expect(state.messages).toHaveLength(0);
  });
});

describe('RENAME_STREAMING', () => {
  test('renaming a streaming session moves it in one step', () => {
    let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
    state = chatReducer(state, {
      type: 'RENAME_STREAMING',
      fromSessionId: -1,
      toSessionId: 42,
    });
    expect(state.streamingSessions.has(-1)).toBe(false);
    expect(state.streamingSessions.has(42)).toBe(true);
    expect(state.streamingSessions.size).toBe(1);
  });

  test('renaming does not clear the steer state or the pending model switch', () => {
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
    expect(state.activeSubagentId).toBe('research');
    expect(state.modelSwitchPendingSessions.has(42)).toBe(true);
    expect(state.steerDrafts.get(42)?.id).toBe('d1');
  });
});

describe('CLEAR_SUBAGENT_CONTENT', () => {
  // A sub-agent's turn that failed with a transient provider error is
  // re-issued, so the text the failed attempt streamed has to go — while the
  // text of the agent's EARLIER turns stays. The server knows what remains and
  // sends it with the event, so the trace is REPLACED with that text (not
  // emptied): the re-issued turn keeps streaming into the same trace.
  const clear = (state, overrides) =>
    chatReducer(state, {
      type: 'CLEAR_SUBAGENT_CONTENT',
      toolCallId: 'call-1',
      agentId: 'research',
      content: 'EARLIER-TURN-TEXT',
      ...overrides,
    });

  test('clearing a sub-agent replaces its trace with the text that remains', () => {
    expect(tracesOf(clear(stateWithTraces()))[0]).toStrictEqual(
      trace('research', 'EARLIER-TURN-TEXT')
    );
  });

  test('the replaced trace is still there (replaced, not removed)', () => {
    const state = clear(stateWithTraces());
    expect(state.messages).toHaveLength(1);
    expect(tracesOf(state).map((t) => t.agentId)).toStrictEqual(['research', 'writer']);
  });

  test('another agent’s trace is untouched', () => {
    expect(tracesOf(clear(stateWithTraces()))[1]).toStrictEqual(trace('writer', 'other agent'));
  });

  test('clearing an unknown agent with no text changes nothing', () => {
    const before = stateWithTraces();
    expect(clear(before, { agentId: 'nobody', content: '' })).toBe(before);
  });

  test('clearing an unknown agent with text creates its trace', () => {
    // The server says there IS text that has to remain for that agent, so it
    // is created rather than dropped — otherwise the remaining text would be
    // lost from the transcript.
    const state = clear(stateWithTraces(), { agentId: 'nobody' });
    expect(tracesOf(state)).toHaveLength(3);
    expect(tracesOf(state)[2]).toStrictEqual(trace('nobody', 'EARLIER-TURN-TEXT'));
  });

  test('only the card of THAT call is touched, even when another call used the same agent id', () => {
    let state = stateWithTraces();
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: callCard('call-2', [trace('research', 'SECOND-CALL')]),
    });
    const cleared = clear(state);
    expect(cleared.messages[0].subagentTraces[0].content).toBe('EARLIER-TURN-TEXT');
    expect(cleared.messages[1].subagentTraces[0].content).toBe('SECOND-CALL');
  });

  test('a clear for another session replaces that session’s trace only', () => {
    let state = stateWithSessions();
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: callCard('call-1', [trace('research', 'PARTIAL-ANSWER')]),
      targetSessionId: 9,
    });
    const cleared = clear(state, { targetSessionId: 9 });
    expect(cleared.sessionStates.get(9)?.messages.at(-1)?.subagentTraces).toStrictEqual([
      trace('research', 'EARLIER-TURN-TEXT'),
    ]);
    // The visible transcript is not touched by a clear aimed at another session.
    expect(cleared.messages.length).toBe(state.messages.length);
    expect(cleared.messages[0].content).toBe('visible');
  });

  test('a clear for another session creates the trace on that session’s card', () => {
    let state = stateWithSessions();
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: callCard('call-1'),
      targetSessionId: 9,
    });
    const cleared = clear(state, { targetSessionId: 9 });
    expect(cleared.sessionStates.get(9)?.messages.at(-1)?.subagentTraces).toStrictEqual([
      trace('research', 'EARLIER-TURN-TEXT'),
    ]);
    expect(cleared.messages.length).toBe(state.messages.length);
  });
});

describe('which card a trace attaches to', () => {
  const chunk = (state, overrides) =>
    chatReducer(state, {
      type: 'SUBAGENT_CHUNK',
      toolCallId: 'call-2',
      agentId: 'research',
      text: 'NEW',
      ...overrides,
    });

  test('an agent id that comes back in a later call starts a trace of its own', () => {
    // The bug this exists for: the reducer used to continue the LAST bubble of
    // the agent anywhere in the history, so a reused id ("researcher" in turn
    // 3 and again in turn 9) wrote into the old call's bubble.
    let state = stateWithTraces();
    state = chatReducer(state, { type: 'ADD_MESSAGE', message: callCard('call-2') });
    const next = chunk(state);
    expect(next.messages[0].subagentTraces[0].content).toBe('PARTIAL-ANSWER');
    expect(next.messages[1].subagentTraces).toStrictEqual([trace('research', 'NEW')]);
  });

  test('a trace attaches to a saved result by its tool_call_id too', () => {
    let state = chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 5 });
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: { role: 'tool', content: 'RESULT', tool_call_id: 'call-2' },
    });
    expect(chunk(state).messages[0].subagentTraces).toStrictEqual([trace('research', 'NEW')]);
  });

  test('a chunk that lands AFTER the result card exists still goes to the live card', () => {
    // The page holds streamed text for up to 50 ms, but `tool_result` is applied
    // at once and adds a ✅ card carrying the same id as `tool_call_id`. A
    // flush that fires after that must still land on the live 🔧 card, not
    // start a stray trace on the result card.
    let state = chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 5 });
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: callCard('call-2', [trace('research', 'EARLY')]),
    });
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: {
        role: 'tool',
        content: '✅ **run_subagents**',
        name: 'run_subagents',
        tool_call_id: 'call-2',
      },
    });
    const next = chunk(state, { text: '-TAIL' });
    expect(next.messages[0].subagentTraces).toStrictEqual([trace('research', 'EARLY-TAIL')]);
    expect(next.messages[1]).toBe(state.messages[1]);
  });

  test('an event for a call with no card is dropped, not attached elsewhere', () => {
    // The text is not lost: the server saves its own copy on the tool message,
    // and the end-of-turn reload brings it back.
    const before = stateWithTraces();
    expect(chunk(before, { toolCallId: 'call-unknown' })).toBe(before);
  });

  test('only the card that changed is replaced; every other message keeps its identity', () => {
    let state = stateWithTraces();
    state = chatReducer(state, { type: 'ADD_MESSAGE', message: callCard('call-2') });
    const next = chunk(state);
    expect(next.messages[0]).toBe(state.messages[0]);
    expect(next.messages[1]).not.toBe(state.messages[1]);
    // The traces array is copied, never mutated in place.
    expect(state.messages[1].subagentTraces).toBeUndefined();
  });
});

describe("SUBAGENT_OUTPUT / the server's copy of the same text", () => {
  // The CLIENT's rule is the reference: a line is appended with a newline
  // BETWEEN two entries and NONE before the first one, and a streamed chunk
  // is appended raw.
  //
  // The server keeps its own copy of the same text (the bucket the saved trace
  // is built from), and the clear that drops a failed turn's output REPLACES
  // the client's trace with the server's copy — so the two copies have to be
  // byte-identical at every point. The server used to append a trailing newline
  // instead, which put the newline in a different place than the client did:
  // the same characters in a different order, so the replacement visibly
  // reordered the surviving text.
  const onCard = () =>
    chatReducer(chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 5 }), {
      type: 'ADD_MESSAGE',
      message: callCard('call-1'),
    });
  const output = (state, message) =>
    chatReducer(state, {
      type: 'SUBAGENT_OUTPUT',
      toolCallId: 'call-1',
      agentId: 'research',
      message,
    });
  const text = (state) => tracesOf(state)[0].content;

  test('the first line is the trace’s whole content (no leading newline)', () => {
    expect(text(output(onCard(), 'FIRST-LINE'))).toBe('FIRST-LINE');
  });

  test('a second line is separated by exactly one newline', () => {
    expect(text(output(output(onCard(), 'FIRST-LINE'), 'SECOND-LINE'))).toBe(
      'FIRST-LINE\nSECOND-LINE'
    );
  });

  test('the server’s transcript and the client’s trace are byte-identical', () => {
    // The same writes, in the same order, through both sides.
    const writes = [
      { kind: 'chunk', text: 'TURN-ONE-TEXT' },
      { kind: 'line', message: '↻ Provider error (500) — retrying this turn (attempt 2/3).' },
      { kind: 'chunk', text: 'TURN-TWO-TEXT' },
      { kind: 'line', message: '⚠ Sub-agent stopped: the provider gave up.' },
    ];

    let state = onCard();
    let server = '';
    for (const write of writes) {
      if (write.kind === 'chunk') {
        state = chatReducer(state, {
          type: 'SUBAGENT_CHUNK',
          toolCallId: 'call-1',
          agentId: 'research',
          text: write.text,
        });
        server += write.text;
      } else {
        state = output(state, write.message);
        server = appendSubagentLineText(server, write.message);
      }
    }

    expect(text(state)).toBe(server);
  });

  test('the clear’s replacement (the server’s copy) is the client’s trace', () => {
    // The clear replaces the trace with the text the server kept, so the
    // replacement must not change a single character.
    let state = onCard();
    state = chatReducer(state, {
      type: 'SUBAGENT_CHUNK',
      toolCallId: 'call-1',
      agentId: 'research',
      text: 'TURN-ONE',
    });
    state = output(state, '↻ Provider error');
    const server = appendSubagentLineText('TURN-ONE', '↻ Provider error');
    const cleared = chatReducer(state, {
      type: 'CLEAR_SUBAGENT_CONTENT',
      toolCallId: 'call-1',
      agentId: 'research',
      content: server,
    });
    expect(text(cleared)).toBe(text(state));
  });
});

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
  ['tool_call', { name: 'run_subagents', arguments: { agents: [] }, toolCallId: 'sub-1' }],
  ['subagent_output', { toolCallId: 'sub-1', agentId: 'researcher', message: 'starting' }],
  ['subagent_chunk', { toolCallId: 'sub-1', agentId: 'researcher', text: 'half' }],
  ['clear_subagent', { toolCallId: 'sub-1', agentId: 'researcher', content: 'starting' }],
  ['subagent_chunk', { toolCallId: 'sub-1', agentId: 'researcher', text: '\nredone' }],
  // The result is applied at once, but streamed text is held for a moment: a
  // chunk that arrives AFTER the result card exists must still reach the live card.
  ['tool_result', { name: 'run_subagents', result: 'done', duration: 9, toolCallId: 'sub-1' }],
  ['subagent_chunk', { toolCallId: 'sub-1', agentId: 'researcher', text: ' (late tail)' }],
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

describe('switching conversations while a turn streams', () => {
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
    test(`leaving after frame ${leaveAt} and coming back shows the same conversation`, () => {
      let stayed = startTurnIn7();
      for (const [event, data] of TURN) stayed = applyFrame(stayed, event, data, 7);

      let left = startTurnIn7();
      TURN.forEach(([event, data], index) => {
        if (index === leaveAt) left = chatReducer(left, { type: 'SET_CURRENT_SESSION', id: 9 });
        left = applyFrame(left, event, data, 7);
      });
      if (leaveAt === TURN.length) left = chatReducer(left, { type: 'SET_CURRENT_SESSION', id: 9 });
      left = chatReducer(left, { type: 'SET_CURRENT_SESSION', id: 7 });

      expect(visible(left)).toStrictEqual(visible(stayed));
    });
  }

  test('a background turn never touches the conversation on screen', () => {
    let state = startTurnIn7();
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: { role: 'user', content: 'nine' },
      targetSessionId: 9,
    });
    const before = visible(state);
    for (const [event, data] of TURN) state = applyFrame(state, event, data, 7);
    expect(visible(state)).toStrictEqual(before);
  });

  test('a background error waits in its own conversation', () => {
    let state = startTurnIn7();
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
    state = applyFrame(state, 'error', { message: 'provider fell over' }, 7);
    expect(state.error).toBeNull();
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 7 });
    expect(state.error).toBe('provider fell over');
  });

  test('a background approval does not pop up over another conversation', () => {
    let state = startTurnIn7();
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
    state = applyFrame(
      state,
      'approval_request',
      { requestId: 'req-1', toolName: 'run_command', args: { command: 'rm x' } },
      7
    );
    expect(state.showApproval).toBe(false);
    expect(state.pendingApprovalId).toBeNull();
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 7 });
    expect(state.showApproval).toBe(true);
    expect(state.pendingApprovalId).toBe('req-1');
  });

  test('a session with no approval never shows the new-chat mirror’s approval', () => {
    let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
    state = chatReducer(state, {
      type: 'SHOW_APPROVAL',
      command: { name: 'run_command', args: { command: 'ls' } },
      requestId: 'new-chat-req',
      targetSessionId: -1,
    });
    expect(state.showApproval).toBe(true);
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
    expect(state.showApproval).toBe(false);
    expect(state.pendingApprovalId).toBeNull();
  });

  test('one conversation’s running sub-agent is not another’s steer target', () => {
    let state = startTurnIn7();
    state = applyFrame(state, 'subagent_output', { agentId: 'researcher', message: 'go' }, 7);
    expect(state.activeSubagentId).toBe('researcher');
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
    expect(state.activeSubagentId).toBeNull();
    state = applyFrame(state, 'subagent_chunk', { agentId: 'writer', text: 'x' }, 7);
    expect(state.activeSubagentId).toBeNull();
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 7 });
    expect(state.activeSubagentId).toBe('writer');
  });

  test('a turn ending clears only its own session’s sub-agent', () => {
    let state = startTurnIn7();
    state = chatReducer(state, { type: 'START_STREAMING', sessionId: 9 });
    state = applyFrame(state, 'subagent_output', { agentId: 'seven', message: 'go' }, 7);
    state = applyFrame(state, 'subagent_output', { agentId: 'nine', message: 'go' }, 9);
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 9 });
    expect(state.activeSubagentId).toBe('seven');
    state = chatReducer(state, { type: 'START_STREAMING', sessionId: 9 });
    state = applyFrame(state, 'subagent_output', { agentId: 'nine', message: 'go' }, 9);
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 7 });
    expect(state.activeSubagentId).toBeNull();
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
    expect(state.activeSubagentId).toBe('nine');
  });

  test('a new chat’s early frames are on screen while the new-chat view is', () => {
    let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
    state = applyFrame(state, 'error', { message: 'no such model' }, -1);
    state = applyFrame(state, 'chunk', { content: 'hi' }, -1);
    expect(state.error).toBe('no such model');
    expect(state.messages.at(-1).content).toBe('hi');
    expect(state.newSessionState.messages).toHaveLength(0);
  });

  test('a new chat left before it was saved keeps its transcript once it is', () => {
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
    expect(state.newSessionState.messages).toHaveLength(0);
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 12 });
    expect(state.messages.map((m) => m.content)).toStrictEqual(['opening prompt', 'early reply']);
  });

  test('the new chat on screen keeps its transcript when the server saves it', () => {
    let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: { role: 'user', content: 'opening prompt' },
      targetSessionId: -1,
    });
    state = chatReducer(state, { type: 'RENAME_STREAMING', fromSessionId: -1, toSessionId: 12 });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 12, adoptNewChat: true });
    expect(state.messages.map((m) => m.content)).toStrictEqual(['opening prompt']);
  });

  test('opening another session from the new-chat view does not take the new chat with it', () => {
    let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: { role: 'user', content: 'opening prompt' },
      targetSessionId: -1,
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
    expect(state.messages).toStrictEqual([]);
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: null });
    expect(state.messages.map((m) => m.content)).toStrictEqual(['opening prompt']);
  });

  test('a streaming session the client tracks has a live transcript', () => {
    let state = startTurnIn7();
    expect(hasLiveTranscript(state, 7)).toBe(true);
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
    expect(hasLiveTranscript(state, 7)).toBe(true);
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 7 });
    expect(hasLiveTranscript(state, 7)).toBe(false);
    expect(hasLiveTranscript(state, 9)).toBe(false);
  });
});

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

describe('steering drafts, restore text and the model-switch flag', () => {
  const userMessage = (content) => ({ role: 'user', content });

  /** Sessions 5 (on screen) and 9 both streaming. */
  function twoStreaming() {
    let state = chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 5 });
    state = chatReducer(state, { type: 'START_STREAMING', sessionId: 5 });
    return chatReducer(state, { type: 'START_STREAMING', sessionId: 9 });
  }

  test('a steering draft belongs to the session it was sent for', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 9, draft: steerDraft('d1') });
    expect(state.steerDrafts.has(9)).toBe(true);
    expect(state.steerDrafts.has(5)).toBe(false);
  });

  test('releasing a draft that does not exist changes nothing', () => {
    const state = twoStreaming();
    expect(chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: null })).toBe(state);
  });

  test('a turn ending settles only ITS session’s draft', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: steerDraft('d5') });
    state = chatReducer(state, {
      type: 'SET_STEER_DRAFT',
      sessionId: 9,
      draft: steerDraft('d9', 'other'),
    });
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
    expect(state.steerDrafts.has(5)).toBe(false);
    expect(state.steerDrafts.get(9)?.id).toBe('d9');
    expect(state.steerRestoreTexts.has(9)).toBe(false);
  });

  test('an unacknowledged steer that is not in the history is put back, for its own session', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'ADD_MESSAGE', message: userMessage('hello') });
    state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: steerDraft('d5') });
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
    expect(state.steerRestoreTexts.get(5)).toBe(STEER_TEXT);
    expect(state.steerRestoreTexts.has(9)).toBe(false);
  });

  test('a steer the server already saved is NOT put back (conversation on screen)', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: steerDraft('d5') });
    // The turn's end reloads the transcript from the database before STOP: the
    // server saved the steer as a user message.
    state = chatReducer(state, { type: 'ADD_MESSAGE', message: userMessage(STEER_TEXT) });
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
    expect(state.steerDrafts.has(5)).toBe(false);
    expect(state.steerRestoreTexts.has(5)).toBe(false);
  });

  test('a steer the server already saved is NOT put back (conversation in the background)', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 9, draft: steerDraft('d9') });
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: userMessage(STEER_TEXT),
      targetSessionId: 9,
    });
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 9 });
    expect(state.steerRestoreTexts.has(9)).toBe(false);
    expect(state.steerRestoreTexts.has(5)).toBe(false);
  });

  test('an identical EARLIER message does not count as the saved steer', () => {
    let state = twoStreaming();
    // The transcript already held one copy when the steer was sent.
    state = chatReducer(state, { type: 'ADD_MESSAGE', message: userMessage(STEER_TEXT) });
    state = chatReducer(state, {
      type: 'SET_STEER_DRAFT',
      sessionId: 5,
      draft: steerDraft('d5', STEER_TEXT, 1),
    });
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
    expect(state.steerRestoreTexts.get(5)).toBe(STEER_TEXT);
  });

  test('one MORE copy than before the steer counts as the saved steer', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'ADD_MESSAGE', message: userMessage(STEER_TEXT) });
    state = chatReducer(state, {
      type: 'SET_STEER_DRAFT',
      sessionId: 5,
      draft: steerDraft('d5', STEER_TEXT, 1),
    });
    state = chatReducer(state, { type: 'ADD_MESSAGE', message: userMessage(STEER_TEXT) });
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
    expect(state.steerRestoreTexts.has(5)).toBe(false);
  });

  test('an acknowledged draft has nothing left to settle', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: steerDraft('d5') });
    state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: null });
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
    expect(state.steerRestoreTexts.has(5)).toBe(false);
  });

  test('restored text stays with its conversation when the user switches', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 5, draft: steerDraft('d5') });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
    // The user is looking at 9; the text belongs to 5 and is filed under 5.
    expect(state.steerRestoreTexts.get(5)).toBe(STEER_TEXT);
    expect(state.steerRestoreTexts.has(9)).toBe(false);
    state = chatReducer(state, { type: 'CLEAR_STEER_RESTORE', sessionId: 9 });
    expect(state.steerRestoreTexts.get(5)).toBe(STEER_TEXT);
    state = chatReducer(state, { type: 'CLEAR_STEER_RESTORE', sessionId: 5 });
    expect(state.steerRestoreTexts.has(5)).toBe(false);
  });

  test('a pending model switch belongs to its session', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 9, pending: true });
    expect(state.modelSwitchPendingSessions.has(9)).toBe(true);
    expect(state.modelSwitchPendingSessions.has(5)).toBe(false);
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 5 });
    expect(state.modelSwitchPendingSessions.has(9)).toBe(true);
    state = chatReducer(state, { type: 'STOP_STREAMING', sessionId: 9 });
    expect(state.modelSwitchPendingSessions.has(9)).toBe(false);
  });

  test('a pending model switch is released by the confirmation for its session', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 5, pending: true });
    state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 9, pending: true });
    state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 9, pending: false });
    expect([...state.modelSwitchPendingSessions]).toStrictEqual([5]);
  });

  test('SET_SESSION_SELECTION leaves the global compaction provider alone when the defaults do not state it (BUG 9)', () => {
    // `defaults.compactionProviderId` is typed as always present, so a caller
    // that omits it compiles; the reducer used to write `undefined` over a
    // pin that was set.
    const selection = {
      model: 'm',
      providerId: 'p',
      compaction: { kind: 'inherit-default' },
      reasoningEffort: null,
      compactionReasoningEffort: null,
    };
    const defaultsWithout = {
      model: 'm',
      providerId: 'p',
      compactionModel: 'beam',
      reasoningEffort: 'off',
      compactionReasoningEffort: 'off',
    };
    let state = chatReducer(initialState, {
      type: 'SET_DEFAULT_SELECTION',
      model: 'm',
      providerId: 'p',
      compactionModel: 'beam',
      compactionProviderId: 'ollama-cloud',
    });
    expect(state.defaultCompactionProviderId).toBe('ollama-cloud');
    state = chatReducer(state, {
      type: 'SET_SESSION_SELECTION',
      selection,
      defaults: defaultsWithout,
    });
    expect(state.defaultCompactionProviderId).toBe('ollama-cloud');
    // a stated value is applied, and `null` still means "clear it"
    state = chatReducer(state, {
      type: 'SET_SESSION_SELECTION',
      selection,
      defaults: { ...defaultsWithout, compactionProviderId: 'other' },
    });
    expect(state.defaultCompactionProviderId).toBe('other');
    state = chatReducer(state, {
      type: 'SET_SESSION_SELECTION',
      selection,
      defaults: { ...defaultsWithout, compactionProviderId: null },
    });
    expect(state.defaultCompactionProviderId).toBeNull();
  });

  test('discarding a session drops its steer and switch state', () => {
    let state = twoStreaming();
    state = chatReducer(state, { type: 'SET_STEER_DRAFT', sessionId: 9, draft: steerDraft('d9') });
    state = chatReducer(state, { type: 'SET_MODEL_SWITCH_PENDING', sessionId: 9, pending: true });
    state = chatReducer(state, { type: 'DISCARD_SESSION', sessionId: 9 });
    expect(state.steerDrafts.has(9)).toBe(false);
    expect(state.modelSwitchPendingSessions.has(9)).toBe(false);
  });
});

describe('the wiring the components must keep', () => {
  // The components cannot run without React, so the source is read.
  const readSource = (path) =>
    fs.readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const steerInputSource = readSource('../src/components/SteerInput/SteerInput.tsx');
  const chatInputSource = readSource('../src/components/ChatInput/ChatInput.tsx');
  const statusBarSource = readSource('../src/components/StatusBar/StatusBar.tsx');

  test('the steer box files its draft under the session it sent to, not the one on screen later', () => {
    expect(steerInputSource).toContain('sessionId: streamingSessionId');
    expect(steerInputSource).toContain('copiesAtSend');
    expect(steerInputSource).toContain('steerDrafts.has(streamingSessionId)');
  });

  test('the composer only takes the restore text of the conversation it shows', () => {
    expect(chatInputSource).toContain('state.steerRestoreTexts.get(state.currentSessionId)');
    expect(chatInputSource).toContain(
      "type: 'CLEAR_STEER_RESTORE', sessionId: state.currentSessionId"
    );
  });

  test('the status bar shows the pending switch of the conversation on screen only', () => {
    expect(statusBarSource).toContain('modelSwitchPendingSessions.has(currentSessionId)');
  });
});

describe('background updates go through the batched dispatcher', () => {
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
      test(`leaving after frame ${leaveAt} and coming back ends the same batched or not${ticks ? ' (with the timer firing along the way)' : ''}`, () => {
        const script = turnScript(leaveAt, { ticks });
        const batched = play(script, { batched: true });
        const direct = play(script, { batched: false });
        expect(visible(batched)).toStrictEqual(visible(direct));
        expect(transcripts(batched)).toStrictEqual(transcripts(direct));
      });
    }
  }

  test('background updates are held back until the interval, then arrive together', () => {
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
    expect(slotText()).toBe('');
    clock.advance(BATCH_INTERVAL);
    expect(slotText()).toBe('one two three');
  });

  test('a reload from the database is never followed by older queued text', () => {
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
    expect(transcripts(batched)).toStrictEqual(transcripts(direct));
    expect(transcripts(batched)[7].map((m) => m.content)).toStrictEqual([
      'go',
      'the final reply',
      STEER_TEXT,
    ]);
    expect(batched.steerRestoreTexts.has(7)).toBe(false);
  });

  test('a new chat left before it was saved ends the same batched or not', () => {
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
    expect(transcripts(batched)).toStrictEqual(transcripts(direct));
    expect(batched.messages.map((m) => m.content)).toStrictEqual([
      'opening prompt',
      'early text reply',
    ]);
    expect(batched.newSessionState.messages).toHaveLength(0);
  });

  test('a conversation that comes on screen while its update is queued still lands in the right place', () => {
    const script = [
      { action: { type: 'SET_CURRENT_SESSION', id: 5 } },
      { action: { type: 'START_STREAMING', sessionId: 7 } },
      { frame: ['chunk', { content: 'queued while 7 was in the background' }, 7] },
      { action: { type: 'SET_CURRENT_SESSION', id: 7 } },
      { frame: ['chunk', { content: ' and dispatched while on screen' }, 7] },
    ];
    const batched = play(script, { batched: true });
    expect(batched.messages.at(-1).content).toBe(
      'queued while 7 was in the background and dispatched while on screen'
    );
    expect(transcripts(batched)).toStrictEqual(transcripts(play(script, { batched: false })));
  });
});

describe('the server’s book of traces writes what the client’s reducer writes', () => {
  // The chat route files every write in a `SubagentTraceBook`, and the clear that
  // drops a failed turn's output REPLACES the client's trace with the book's
  // text. So the two must agree on every character, at every step, with the
  // same writes in the same order.
  test('lines and chunks, then a clear, leave identical text on both sides', () => {
    const book = new SubagentTraceBook();
    let state = chatReducer(chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 5 }), {
      type: 'ADD_MESSAGE',
      message: callCard('call-1'),
    });

    const writes = [
      ['chunk', 'TURN-ONE'],
      ['line', '↻ Provider error (500)'],
      ['chunk', 'TURN-TWO'],
      ['line', '⚠ gave up'],
    ];
    for (const [kind, text] of writes) {
      if (kind === 'chunk') {
        book.appendChunk('call-1', 'research', text);
        state = chatReducer(state, {
          type: 'SUBAGENT_CHUNK',
          toolCallId: 'call-1',
          agentId: 'research',
          text,
        });
      } else {
        book.appendLine('call-1', 'research', text);
        state = chatReducer(state, {
          type: 'SUBAGENT_OUTPUT',
          toolCallId: 'call-1',
          agentId: 'research',
          message: text,
        });
      }
    }
    // Drop the last turn (TURN-TWO + the line after it), as the route does.
    const dropped = '⚠ gave up'.length + 1 + 'TURN-TWO'.length;
    const remaining = book.dropTail('call-1', 'research', dropped);
    state = chatReducer(state, {
      type: 'CLEAR_SUBAGENT_CONTENT',
      toolCallId: 'call-1',
      agentId: 'research',
      content: remaining,
    });
    expect(tracesOf(state)).toStrictEqual(book.take('call-1'));
  });
});
