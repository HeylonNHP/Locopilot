/**
 * Tests for the per-conversation model selection.
 *
 * WHY this exists: the model used to be one global value, so every
 * conversation ran on whatever the picker happened to be pointing at. The
 * selection now belongs to the conversation, which means the selection has to
 * survive three crossings - the database row, the store, and the push that
 * tells another tab - and each of them could quietly lose a piece of it.
 *
 * The checks below cover those crossings:
 *
 *  - the selection's vocabulary (`src/services/sessionSelection.ts`), where
 *    "not pinned" and "inherit the default" are two different nulls;
 *  - the database round trip, because the row is where the selection lives
 *    between reloads;
 *  - the store, because switching conversations is what has to restore the
 *    selection of the conversation being switched to;
 *  - the wire contract, because the producer and the consumer of the push
 *    are in different processes.
 *
 * ISOLATION: `DB_PATH` is `process.cwd()`-relative, so this script chdirs
 * into a fresh `mkdtemp` BEFORE importing the store. Importing first would
 * open and mutate the checkout's real ./locopilot.db.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Resolves a repo-relative module against this script, not against the cwd. */
const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = (relative) => pathToFileURL(path.join(here, relative)).href;

const root = mkdtempSync(path.join(tmpdir(), 'locopilot-session-model-selection-'));
const previousCwd = process.cwd();

let createSession;
let listSessions;
let updateSessionSelection;
let subscribeSessionEvents;
let validateSessionSelection;
let chatReducer;
let initialState;
let parseSessionEvent;

beforeAll(async () => {
  // Must precede the import: `history.ts` builds `DB_PATH` at module load.
  process.chdir(root);

  ({ createSession, listSessions, updateSessionSelection } = await import(
    moduleUrl('../src/services/history.ts')
  ));
  ({ subscribeSessionEvents } = await import(moduleUrl('../src/services/sessionEvents.ts')));
  ({ validateSessionSelection } = await import(moduleUrl('../src/services/sessionSelection.ts')));
  ({ chatReducer, initialState } = await import(moduleUrl('../src/app/lib/chatStore.ts')));
  ({ parseSessionEvent } = await import(moduleUrl('../src/app/hooks/useSessionEvents.ts')));
});

afterAll(() => {
  // Restore the cwd before removing the scratch root (Windows keeps the
  // directory busy while it is the cwd) and never leave the DB behind.
  process.chdir(previousCwd);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while `history.ts` holds it open.
    // The scratch root lives in the OS temp folder, so it goes away with the
    // rest of it; failing the suite over it would report a green run as red.
  }
});

/** The selection of a conversation that runs on one model and nothing else. */
const SELECTION = {
  model: 'deepseek-v4.1-flash',
  providerId: 'deepseek',
  compactionModel: null,
  compactionProviderId: null,
};

/** A conversation row as the store holds it. */
function row(id, overrides) {
  return {
    id,
    name: `conversation ${id}`,
    model: 'minimax-m3.1-flash',
    provider_id: 'minimax',
    compaction_model: null,
    compaction_provider_id: null,
    created_at: '2026-11-13 00:00:00',
    updated_at: '2026-11-13 00:00:00',
    ...overrides,
  };
}

describe('the selection vocabulary', () => {
  test('a selection keeps the provider that serves the model', () => {
    const validated = validateSessionSelection({
      model: '  deepseek-v4.1-flash  ',
      providerId: ' deepseek ',
      compactionModel: 'minimax-m3.1-flash',
      compactionProviderId: 'minimax',
    });

    expect(validated).toStrictEqual({
      model: 'deepseek-v4.1-flash',
      providerId: 'deepseek',
      compactionModel: 'minimax-m3.1-flash',
      compactionProviderId: 'minimax',
    });
  });

  test('an absent compaction model and an empty one mean different things', () => {
    // null: the conversation inherits the global default.
    // '': the conversation compacts with its own main model.
    expect(validateSessionSelection({ model: 'm' })).toStrictEqual({
      model: 'm',
      providerId: null,
      compactionModel: null,
      compactionProviderId: null,
    });
    expect(validateSessionSelection({ model: 'm', compactionModel: '' })).toStrictEqual({
      model: 'm',
      providerId: null,
      compactionModel: '',
      compactionProviderId: null,
    });
  });

  test('a selection without a model is rejected, and the reason names the field', () => {
    expect(validateSessionSelection({ model: '' })).toBe('model must be a non-empty string');
    expect(validateSessionSelection({})).toBe('model must be a non-empty string');
    expect(validateSessionSelection({ model: 'm', providerId: 7 })).toBe(
      'providerId must be a string or null'
    );
    expect(validateSessionSelection('not an object')).toBe('The model selection must be an object');
  });
});

describe('the selection in the database', () => {
  test('a conversation is born with the selection it will run on', () => {
    const id = createSession('New chat', SELECTION);
    const stored = listSessions().find((s) => s.id === id);

    expect(stored).toBeDefined();
    expect(stored.model).toBe('deepseek-v4.1-flash');
    expect(stored.provider_id).toBe('deepseek');
    expect(stored.compaction_model).toBeNull();
    expect(stored.compaction_provider_id).toBeNull();
  });

  test('a new selection replaces the old one', () => {
    const id = createSession('New chat', SELECTION);
    updateSessionSelection(id, {
      model: 'minimax-m3.1-flash',
      providerId: 'minimax',
      compactionModel: '',
      compactionProviderId: null,
    });

    const stored = listSessions().find((s) => s.id === id);
    expect(stored.model).toBe('minimax-m3.1-flash');
    expect(stored.provider_id).toBe('minimax');
    expect(stored.compaction_model).toBe('');
  });

  test('a new selection is announced to the open tabs', () => {
    const id = createSession('New chat', SELECTION);
    const events = [];
    const unsubscribe = subscribeSessionEvents((event) => events.push(event));

    try {
      updateSessionSelection(id, {
        model: 'minimax-m3.1-flash',
        providerId: 'minimax',
        compactionModel: null,
        compactionProviderId: null,
      });
    } finally {
      unsubscribe();
    }

    expect(events).toStrictEqual([
      {
        kind: 'model-changed',
        sessionId: id,
        model: 'minimax-m3.1-flash',
        providerId: 'minimax',
        compactionModel: null,
        compactionProviderId: null,
      },
    ]);
  });
});

describe('the selection in the store', () => {
  test('switching conversations switches the model with them', () => {
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {}), row(2, { model: 'gpt-5', provider_id: 'openai' })],
    });

    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    expect(state.model).toBe('minimax-m3.1-flash');
    expect(state.activeProviderId).toBe('minimax');
    expect(state.compactionModel).toBeNull();

    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 2 });
    expect(state.model).toBe('gpt-5');
    expect(state.activeProviderId).toBe('openai');
  });

  test('a conversation keeps its own compaction model', () => {
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, { compaction_model: 'cheap', compaction_provider_id: 'openai' })],
    });

    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    expect(state.compactionModel).toBe('cheap');
    expect(state.compactionProviderId).toBe('openai');
  });

  test('picking a model pins the conversation and updates the default', () => {
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {})],
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });

    state = chatReducer(state, {
      type: 'SET_SESSION_SELECTION',
      selection: {
        model: 'gpt-5',
        providerId: 'openai',
        compactionModel: null,
        compactionProviderId: null,
      },
      defaults: { model: 'gpt-5', providerId: 'openai', compactionModel: '' },
    });

    expect(state.model).toBe('gpt-5');
    expect(state.activeProviderId).toBe('openai');
    // The conversation's own row carries it, so the conversation keeps this
    // model when the user comes back to it.
    expect(state.sessions[0].model).toBe('gpt-5');
    expect(state.sessions[0].provider_id).toBe('openai');
    // Picking a model is also what the next new conversation starts with.
    expect(state.defaultModel).toBe('gpt-5');
    expect(state.defaultProviderId).toBe('openai');
  });

  test('the defaults are the ones the pick states, not the conversation’s selection', () => {
    // A pick of the MAIN model must not move the default compaction model,
    // and a pick of the COMPACTION model must not move the default main
    // model: the two pickers are separate controls.
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {})],
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });

    state = chatReducer(state, {
      type: 'SET_SESSION_SELECTION',
      selection: {
        model: 'gpt-5',
        providerId: 'openai',
        compactionModel: null,
        compactionProviderId: null,
      },
      defaults: { model: 'gpt-5', providerId: 'openai', compactionModel: 'cheap-compactor' },
    });

    expect(state.defaultCompactionModel).toBe('cheap-compactor');
    expect(state.defaultModel).toBe('gpt-5');
  });

  test('a config that arrives after a conversation was opened does not move its model', () => {
    // The conversation was opened before the list arrived, so its row was not
    // known yet and the mirror fell back to the global default.
    let state = chatReducer(initialState, {
      type: 'SET_CONFIG',
      config: { defaultModel: 'global-model', defaultProviderId: 'global-provider' },
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    expect(state.model).toBe('global-model');

    // The conversation's own row arrives and says something else.
    state = chatReducer(state, {
      type: 'APPLY_SESSION_SELECTION',
      sessionId: 1,
      selection: {
        model: 'conversation-model',
        providerId: 'p1',
        compactionModel: null,
        compactionProviderId: null,
      },
    });
    expect(state.model).toBe('conversation-model');

    // The config arrives late. It must not move the model under the user.
    state = chatReducer(state, {
      type: 'SET_CONFIG',
      config: { defaultModel: 'other-global-model', defaultProviderId: 'other-provider' },
    });
    expect(state.model).toBe('conversation-model');
    expect(state.activeProviderId).toBe('p1');
  });

  test('a session list that is a moment older does not roll back a pick', () => {
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {})],
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    state = chatReducer(state, {
      type: 'SET_SESSION_SELECTION',
      selection: {
        model: 'picked',
        providerId: 'picked-provider',
        compactionModel: null,
        compactionProviderId: null,
      },
      defaults: { model: 'picked', providerId: 'picked-provider', compactionModel: '' },
    });
    expect(state.model).toBe('picked');

    // A list fetched before the pick landed still carries the old model.
    state = chatReducer(state, {
      type: 'SET_SESSIONS',
      sessions: [row(1, { model: 'old', provider_id: 'old-provider' })],
    });
    expect(state.model).toBe('picked');
    expect(state.sessions[0].model).toBe('picked');

    // Switching away and back keeps the pick.
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 2 });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    expect(state.model).toBe('picked');
  });

  test("another tab's change does not move the model under the user", () => {
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {}), row(2, { model: 'gpt-5', provider_id: 'openai' })],
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    expect(state.model).toBe('minimax-m3.1-flash');

    state = chatReducer(state, {
      type: 'APPLY_SESSION_SELECTION',
      sessionId: 2,
      selection: {
        model: 'claude',
        providerId: 'anthropic',
        compactionModel: null,
        compactionProviderId: null,
      },
    });

    // The conversation on screen still runs on its own model; the other
    // conversation's row is updated.
    expect(state.model).toBe('minimax-m3.1-flash');
    expect(state.sessions[1].model).toBe('claude');
    expect(state.sessions[1].provider_id).toBe('anthropic');
  });

  test('the conversation on screen follows its own change', () => {
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {})],
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });

    state = chatReducer(state, {
      type: 'APPLY_SESSION_SELECTION',
      sessionId: 1,
      selection: {
        model: 'claude',
        providerId: 'anthropic',
        compactionModel: null,
        compactionProviderId: null,
      },
    });

    expect(state.model).toBe('claude');
    expect(state.activeProviderId).toBe('anthropic');
  });
});

describe('the selection on the wire', () => {
  test('a model change frame is parsed into the selection it carries', () => {
    const frame = JSON.stringify({
      kind: 'model-changed',
      sessionId: 29,
      model: 'gpt-5',
      providerId: 'openai',
      compactionModel: '',
      compactionProviderId: null,
    });

    expect(parseSessionEvent(frame)).toStrictEqual({
      kind: 'model-changed',
      sessionId: 29,
      selection: {
        model: 'gpt-5',
        providerId: 'openai',
        compactionModel: '',
        compactionProviderId: null,
      },
    });
  });

  test('a rename frame is still parsed as a rename', () => {
    const frame = JSON.stringify({ kind: 'renamed', sessionId: 29, name: 'A chat' });

    expect(parseSessionEvent(frame)).toStrictEqual({
      kind: 'renamed',
      sessionId: 29,
      name: 'A chat',
    });
  });

  test('a frame without a model is dropped', () => {
    expect(parseSessionEvent(JSON.stringify({ kind: 'model-changed', sessionId: 29 }))).toBeNull();
    expect(parseSessionEvent(JSON.stringify({ kind: 'model-changed' }))).toBeNull();
    expect(parseSessionEvent('not json')).toBeNull();
  });
});
