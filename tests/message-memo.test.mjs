/**
 * Tests for "skip redrawing messages that did not change".
 *
 * No network, no server, no DOM.
 *
 * Every store update re-renders the page. `ChatMessageBubble` is exported
 * through `React.memo` with the default shallow comparison, so a bubble is
 * redrawn only when one of its props changes. That only works while:
 *
 *   - the reducer keeps every message it did not change as the SAME object —
 *     an update that copies every message (`.map(m => ({ ...m }))`) would
 *     silently redraw the whole conversation again on every chunk;
 *   - moving a transcript between the screen and a session slot moves the
 *     array, it does not copy it;
 *   - the bubble is exported through memo, reads no chat context, and
 *     MessagesArea gives it no prop that is new on every render.
 *
 * The one documented exception: a reload from the database (`SET_MESSAGES`,
 * at the end of every turn and after a compaction) builds new objects, so
 * every bubble redraws once then.
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatReducer, initialState } from '../src/app/lib/chatStore.ts';

const SESSION = 5;
const OTHER = 6;

/** A conversation on screen with one message of every kind, mid-turn. */
function conversation() {
  let state = chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: SESSION });
  state = chatReducer(state, { type: 'START_STREAMING', sessionId: SESSION });
  state = chatReducer(state, {
    type: 'SET_MESSAGES',
    targetSessionId: SESSION,
    messages: [
      { id: 1, role: 'user', content: 'first question' },
      { id: 2, role: 'assistant', content: 'first answer' },
      { id: 3, role: 'user', content: 'second question' },
      { id: 4, role: 'tool', name: 'run_command', content: 'started' },
      { id: 5, role: 'subagent_log', subagentId: 'research', content: 'looking' },
      { id: 6, role: 'assistant', content: 'partial' },
    ],
  });
  return state;
}

/** The messages an action changes, by index; every other one must be `===`. */
const ACTIONS = [
  {
    label: 'ADD_MESSAGE',
    action: { type: 'ADD_MESSAGE', message: { role: 'user', content: 'x' } },
    changed: [],
  },
  {
    label: 'APPLY_ASSISTANT_DELTA',
    action: { type: 'APPLY_ASSISTANT_DELTA', content: ' more' },
    changed: [5],
  },
  {
    label: 'UPDATE_LAST_MESSAGE',
    action: { type: 'UPDATE_LAST_MESSAGE', content: ' more' },
    changed: [5],
    visibleOnly: true,
  },
  {
    label: 'APPEND_TOOL_PROGRESS',
    action: { type: 'APPEND_TOOL_PROGRESS', content: 'line', name: 'run_command' },
    changed: [3],
  },
  {
    label: 'SUBAGENT_CHUNK',
    action: { type: 'SUBAGENT_CHUNK', agentId: 'research', text: ' on' },
    changed: [4],
  },
  {
    label: 'SUBAGENT_OUTPUT',
    action: { type: 'SUBAGENT_OUTPUT', agentId: 'research', message: 'found it' },
    changed: [4],
  },
  {
    label: 'CLEAR_SUBAGENT_CONTENT',
    action: { type: 'CLEAR_SUBAGENT_CONTENT', agentId: 'research', content: '' },
    changed: [4],
  },
  { label: 'REMOVE_LAST_ASSISTANT', action: { type: 'REMOVE_LAST_ASSISTANT' }, changed: [5] },
];

function assertUntouchedKept(before, after, changed) {
  // The action must have done something, or every check below passes vacuously.
  expect(after).not.toStrictEqual(before);
  for (const [i, element] of before.entries()) {
    if (changed.includes(i)) continue;
    if (i >= after.length) continue; // removed
    expect(after[i]).toBe(element);
  }
}

describe('on screen', () => {
  for (const { label, action, changed } of ACTIONS) {
    test(`${label} on the conversation on screen keeps every other message`, () => {
      const state = conversation();
      const next = chatReducer(state, { ...action, targetSessionId: SESSION });
      expect(next.messages).not.toBe(state.messages);
      assertUntouchedKept(state.messages, next.messages, changed);
    });
  }
});

describe('in a background slot', () => {
  for (const { label, action, changed, visibleOnly } of ACTIONS) {
    if (visibleOnly) continue; // has no session target
    test(`${label} on a conversation in the background keeps every other message`, () => {
      const state = chatReducer(conversation(), { type: 'SET_CURRENT_SESSION', id: OTHER });
      const before = state.sessionStates.get(SESSION).messages;
      const next = chatReducer(state, { ...action, targetSessionId: SESSION });
      assertUntouchedKept(before, next.sessionStates.get(SESSION).messages, changed);
    });
  }
});

describe('moving a transcript moves the array', () => {
  test('leaving a conversation and coming back keeps the same message array', () => {
    const state = conversation();
    let next = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: OTHER });
    next = chatReducer(next, { type: 'SET_CURRENT_SESSION', id: SESSION });
    expect(next.messages).toBe(state.messages);
  });

  test('a new chat saved while away keeps the same message array once opened', () => {
    let state = chatReducer(initialState, { type: 'START_STREAMING', sessionId: -1 });
    state = chatReducer(state, {
      type: 'ADD_MESSAGE',
      message: { role: 'user', content: 'opening prompt' },
      targetSessionId: -1,
    });
    state = chatReducer(state, {
      type: 'APPLY_ASSISTANT_DELTA',
      content: 'early',
      targetSessionId: -1,
    });
    const before = state.messages;
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 9 });
    state = chatReducer(state, { type: 'RENAME_STREAMING', fromSessionId: -1, toSessionId: 12 });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 12 });
    expect(state.messages.length).toBe(before.length);
    for (const [i, element] of before.entries()) {
      expect(state.messages[i]).toBe(element);
    }
  });

  test('a status-only update does not touch the message array', () => {
    const state = conversation();
    const next = chatReducer(state, { type: 'SET_ERROR', error: 'boom' });
    expect(next.messages).toBe(state.messages);
  });
});

describe('the documented exception', () => {
  test('a reload from the database builds new objects (every bubble redraws once)', () => {
    const state = conversation();
    const next = chatReducer(state, {
      type: 'SET_MESSAGES',
      targetSessionId: SESSION,
      messages: state.messages.map((m) => ({ ...m })),
    });
    // Not a defect — pinned so a change here is a conscious one.
    expect(next.messages[0]).not.toBe(state.messages[0]);
  });
});

describe('the components', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (relative) =>
    fs.readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');
  const bubbleSource = read('src/components/ChatMessageBubble/ChatMessageBubble.tsx');
  const areaSource = read('src/components/MessagesArea.tsx');

  test('the bubble is exported through memo with the default comparison', () => {
    expect(bubbleSource).toMatch(/export default memo\(ChatMessageBubble\);/);
  });

  test('no bubble, sub-bubble or markdown renderer reads the chat context', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const relative = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(relative);
        else if (/\.tsx?$/.test(entry.name) && /\buseChat\(|useContext\(/.test(read(relative))) {
          offenders.push(relative);
        }
      }
    };
    walk('src/components/ChatMessageBubble');
    walk('src/components/MarkdownMessage');
    expect(offenders).toStrictEqual([]);
  });

  test('MessagesArea gives the bubble no prop that is new on every render', () => {
    const element = areaSource.match(/<ChatMessageBubble[\S\s]*?\/>/);
    expect(element).toBeTruthy();
    expect(element[0]).not.toMatch(/={\s*\(|=>|={{|={\[/);
  });

  test('the delete props go to user bubbles only', () => {
    const element = areaSource.match(/<ChatMessageBubble[\S\s]*?\/>/)[0];
    for (const prop of ['onDeletePrompt', 'isDeletingPrompt', 'canDelete']) {
      expect(element).toMatch(new RegExp(`${prop}=\\{isUser \\? `));
    }
  });
});
