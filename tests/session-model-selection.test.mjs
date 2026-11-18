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
 *    "not pinned" and "inherit the default" are two different states;
 *  - the database round trip, because the row is where the selection lives
 *    between reloads;
 *  - the store, because switching conversations is what has to restore the
 *    selection of the conversation being switched to;
 *  - the wire contract, because the producer and the consumer of the push
 *    are in different processes.
 *
 * THE COMPACTION SELECTION IS ONE VALUE. It used to be two independent
 * nullable fields, which admitted a compaction MODEL without the provider
 * that serves it - the exact state that sent a compaction model to an
 * endpoint that did not have it. It is now a union with THREE states
 * (`inherit-default`, `same-as-main`, `explicit`), so the half-pair has no
 * spelling at all in the store, on the wire, or in a row.
 *
 * ISOLATION: `DB_PATH` is `process.cwd()`-relative, so this script chdirs
 * into a fresh `mkdtemp` BEFORE importing the store. Importing first would
 * open and mutate the checkout's real ./locopilot.db.
 */

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
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
let getSessionSelection;
let subscribeSessionEvents;
let validateSessionSelection;
let validateSessionSelectionPatch;
let mergeSessionSelection;
let resolveCreationSelection;
let parseCompactionSelection;
let compactionSelectionToPair;
let danglingCompactionProviderId;
let planCompactionRepair;
let chatReducer;
let initialState;
let parseSessionEvent;

beforeAll(async () => {
  // Must precede the import: `history.ts` builds `DB_PATH` at module load.
  process.chdir(root);

  ({ createSession, listSessions, updateSessionSelection, getSessionSelection } = await import(
    moduleUrl('../src/services/history.ts')
  ));
  ({ subscribeSessionEvents } = await import(moduleUrl('../src/services/sessionEvents.ts')));
  ({
    validateSessionSelection,
    validateSessionSelectionPatch,
    mergeSessionSelection,
    resolveCreationSelection,
    parseCompactionSelection,
    compactionSelectionToPair,
    danglingCompactionProviderId,
  } = await import(moduleUrl('../src/services/sessionSelection.ts')));
  ({ planCompactionRepair } = await import(moduleUrl('../src/app/lib/compactionRepair.ts')));
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

/** The three legal states of the conversation's own compaction selection. */
const INHERIT_DEFAULT = { kind: 'inherit-default' };
const SAME_AS_MAIN = { kind: 'same-as-main' };
const explicit = (model, providerId) => ({ kind: 'explicit', model, providerId });

/** The selection of a conversation that runs on one model and nothing else. */
const SELECTION = {
  model: 'deepseek-v4.1-flash',
  providerId: 'deepseek',
  compaction: INHERIT_DEFAULT,
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
    reasoning_effort: null,
    compaction_reasoning_effort: null,
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
      compaction: explicit('minimax-m3.1-flash', 'minimax'),
    });

    expect(validated).toStrictEqual({
      model: 'deepseek-v4.1-flash',
      providerId: 'deepseek',
      compaction: explicit('minimax-m3.1-flash', 'minimax'),
      reasoningEffort: null,
      compactionReasoningEffort: null,
    });
  });

  test('the three compaction states are different things', () => {
    // `inherit-default`: the conversation follows the global default.
    // `same-as-main`: the conversation compacts with its own main model.
    expect(validateSessionSelection({ model: 'm' })).toStrictEqual({
      model: 'm',
      providerId: null,
      compaction: INHERIT_DEFAULT,
      reasoningEffort: null,
      compactionReasoningEffort: null,
    });
    expect(validateSessionSelection({ model: 'm', compaction: SAME_AS_MAIN })).toStrictEqual({
      model: 'm',
      providerId: null,
      compaction: SAME_AS_MAIN,
      reasoningEffort: null,
      compactionReasoningEffort: null,
    });
    expect(validateSessionSelection({ model: 'm', compaction: explicit('c', 'p') })).toStrictEqual({
      model: 'm',
      providerId: null,
      compaction: explicit('c', 'p'),
      reasoningEffort: null,
      compactionReasoningEffort: null,
    });
  });

  test('the LEGACY flat pair is still read, and its meaning is kept', () => {
    // A tab that was open before the change still sends the two fields.
    // `toStrictEqual`, not a subset match: a `compaction` that carried extra
    // fields (the flat halves leaking through) would pass `toMatchObject`.
    expect(
      validateSessionSelection({ model: 'm', compactionModel: '', compactionProviderId: null })
    ).toStrictEqual({
      model: 'm',
      providerId: null,
      compaction: SAME_AS_MAIN,
      reasoningEffort: null,
      compactionReasoningEffort: null,
    });
    expect(
      validateSessionSelection({ model: 'm', compactionModel: 'c', compactionProviderId: 'p' })
    ).toStrictEqual({
      model: 'm',
      providerId: null,
      compaction: explicit('c', 'p'),
      reasoningEffort: null,
      compactionReasoningEffort: null,
    });
  });

  test('a legacy provider-only body is paired with the global compaction model, else the main one', () => {
    // Bug hunt A1: creation used to pair it with the conversation's main
    // model only, so the same body resolved differently than on /api/chat.
    expect(validateSessionSelection({ model: 'm', compactionProviderId: 'p' })).toMatchObject({
      compaction: { kind: 'explicit', model: 'm', providerId: 'p' },
    });
    expect(
      validateSessionSelection({ model: 'm', compactionProviderId: 'p' }, 'global-c')
    ).toMatchObject({
      compaction: { kind: 'explicit', model: 'global-c', providerId: 'p' },
    });
  });

  test('a reasoning level is validated, and null means "inherit the default"', () => {
    // Absent and null both mean inherit; the two explicit levels travel.
    expect(
      validateSessionSelection({
        model: 'm',
        reasoningEffort: 'high',
        compactionReasoningEffort: 'max',
      })
    ).toStrictEqual({
      model: 'm',
      providerId: null,
      compaction: INHERIT_DEFAULT,
      reasoningEffort: 'high',
      compactionReasoningEffort: 'max',
    });
    expect(validateSessionSelection({ model: 'm', reasoningEffort: null })).toMatchObject({
      reasoningEffort: null,
    });
    expect(validateSessionSelection({ model: 'm', reasoningEffort: 'loud' })).toBe(
      'reasoningEffort must be one of: off, none, minimal, low, medium, high, xhigh, max'
    );
    expect(validateSessionSelection({ model: 'm', compactionReasoningEffort: 'loud' })).toBe(
      'compactionReasoningEffort must be one of: off, none, minimal, low, medium, high, xhigh, max'
    );
  });

  test('a selection without a model is rejected, and the reason names the field', () => {
    expect(validateSessionSelection({ model: '' })).toBe('model must be a non-empty string');
    expect(validateSessionSelection({})).toBe('model must be a non-empty string');
    expect(validateSessionSelection({ model: 'm', providerId: 7 })).toBe(
      'providerId must be a string or null'
    );
    expect(validateSessionSelection('not an object')).toBe('The model selection must be an object');
  });

  test('a patch keeps only the keys it carries', () => {
    // Absent means "leave unchanged"; an explicit null means "inherit". This
    // is the rule that stops one picker from erasing another's field.
    expect(validateSessionSelectionPatch({ reasoningEffort: 'high' })).toStrictEqual({
      reasoningEffort: 'high',
    });
    expect(validateSessionSelectionPatch({ compaction: INHERIT_DEFAULT })).toStrictEqual({
      compaction: INHERIT_DEFAULT,
    });
    expect(validateSessionSelectionPatch({})).toBe(
      'The model selection patch must contain at least one field'
    );
    expect(validateSessionSelectionPatch({ reasoningEffort: 'loud' })).toBe(
      'reasoningEffort must be one of: off, none, minimal, low, medium, high, xhigh, max'
    );
  });

  describe('the LEGACY flat pair in a patch (a tab open before the change)', () => {
    // The pair is ONE value, so a legacy patch states BOTH halves or NEITHER:
    // editing one half alone leaves the other half describing a different
    // choice. These are the unit-level pins of that refusal; the route-level
    // ones are in session-compaction-pair.test.mjs.
    test.each([
      [{ compactionModel: null }, 'without the compaction provider it travels with'],
      [{ compactionModel: '' }, 'without the compaction provider it travels with'],
      [
        { compactionModel: 'cheap' },
        'The compaction model "cheap" was changed without the provider',
      ],
      [{ compactionProviderId: 'p' }, 'without the compaction model it serves'],
    ])('%j alone is refused with a message that says what to send', (patch, fragment) => {
      const result = validateSessionSelectionPatch(patch);
      expect(typeof result).toBe('string');
      expect(result).toContain(fragment);
      expect(result).toContain('together');
    });

    test.each([
      [{ compactionModel: null, compactionProviderId: null }, INHERIT_DEFAULT],
      [{ compactionModel: '', compactionProviderId: null }, SAME_AS_MAIN],
      [{ compactionModel: 'c', compactionProviderId: 'p' }, explicit('c', 'p')],
    ])('%j, both halves together, means one selection', (patch, compaction) => {
      expect(validateSessionSelectionPatch(patch)).toStrictEqual({ compaction });
    });
  });

  test('a patch merges onto the stored selection without touching absent fields', () => {
    const current = {
      model: 'm',
      providerId: 'p',
      compaction: INHERIT_DEFAULT,
      reasoningEffort: 'low',
      compactionReasoningEffort: 'high',
    };
    expect(mergeSessionSelection(current, { reasoningEffort: 'max' })).toStrictEqual({
      ...current,
      reasoningEffort: 'max',
    });
    expect(mergeSessionSelection(current, { providerId: null })).toStrictEqual({
      ...current,
      providerId: null,
    });
    expect(mergeSessionSelection(current, { compaction: SAME_AS_MAIN })).toStrictEqual({
      ...current,
      compaction: SAME_AS_MAIN,
    });
  });

  test('creation pins a level the caller did not send', () => {
    const resolved = resolveCreationSelection(
      {
        model: 'm',
        providerId: null,
        compaction: INHERIT_DEFAULT,
        reasoningEffort: null,
        compactionReasoningEffort: 'low',
      },
      { reasoningEffort: 'high', compactionReasoningEffort: 'max' }
    );
    // The caller pinned the compaction level; the main level comes from the
    // default. Neither is left null, so a later default change cannot move
    // this conversation.
    expect(resolved.reasoningEffort).toBe('high');
    expect(resolved.compactionReasoningEffort).toBe('low');
    expect(
      resolveCreationSelection(
        { ...resolved, reasoningEffort: null, compactionReasoningEffort: null },
        {}
      )
    ).toMatchObject({ reasoningEffort: 'off', compactionReasoningEffort: 'off' });
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
    // Creation pins the levels; a level the caller did not send is inherited
    // from the default (null from this test's point of view).
    expect(stored.reasoning_effort).toBeNull();
    expect(stored.compaction_reasoning_effort).toBeNull();
  });

  test('a conversation keeps its own reasoning levels', () => {
    const id = createSession('New chat', {
      ...SELECTION,
      reasoningEffort: 'high',
      compactionReasoningEffort: 'low',
    });

    expect(getSessionSelection(id)).toStrictEqual({
      ...SELECTION,
      reasoningEffort: 'high',
      compactionReasoningEffort: 'low',
    });
  });

  test('a field-preserving patch leaves the other fields alone', () => {
    const id = createSession('New chat', {
      ...SELECTION,
      reasoningEffort: 'high',
      compactionReasoningEffort: 'low',
    });

    const current = getSessionSelection(id);
    updateSessionSelection(id, mergeSessionSelection(current, { reasoningEffort: 'max' }));
    expect(getSessionSelection(id)).toStrictEqual({
      ...SELECTION,
      reasoningEffort: 'max',
      compactionReasoningEffort: 'low',
    });

    const afterReasoning = getSessionSelection(id);
    updateSessionSelection(
      id,
      mergeSessionSelection(afterReasoning, { model: 'gpt-5', providerId: 'openai' })
    );
    expect(getSessionSelection(id)).toStrictEqual({
      model: 'gpt-5',
      providerId: 'openai',
      compaction: INHERIT_DEFAULT,
      reasoningEffort: 'max',
      compactionReasoningEffort: 'low',
    });
  });

  test('an explicit null in a patch clears a level back to "inherit"', () => {
    const id = createSession('New chat', { ...SELECTION, reasoningEffort: 'high' });
    updateSessionSelection(
      id,
      mergeSessionSelection(getSessionSelection(id), { reasoningEffort: null })
    );
    expect(getSessionSelection(id).reasoningEffort).toBeNull();
  });

  test('a new selection replaces the old one', () => {
    const id = createSession('New chat', SELECTION);
    updateSessionSelection(id, {
      model: 'minimax-m3.1-flash',
      providerId: 'minimax',
      compaction: SAME_AS_MAIN,
    });

    const stored = listSessions().find((s) => s.id === id);
    expect(stored.model).toBe('minimax-m3.1-flash');
    expect(stored.provider_id).toBe('minimax');
    expect(stored.compaction_model).toBe('');
    expect(stored.compaction_provider_id).toBeNull();
  });

  test('a new selection is announced to the open tabs', () => {
    const id = createSession('New chat', SELECTION);
    const events = [];
    const unsubscribe = subscribeSessionEvents((event) => events.push(event));

    try {
      updateSessionSelection(id, {
        model: 'minimax-m3.1-flash',
        providerId: 'minimax',
        compaction: INHERIT_DEFAULT,
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
        compaction: INHERIT_DEFAULT,
        reasoningEffort: null,
        compactionReasoningEffort: null,
      },
    ]);
  });

  test('the announced compaction selection is the NORMALISED one', () => {
    // The frame must carry the pair that was actually WRITTEN, so a browser
    // can never be handed a half-pair. A hand-built half-pair is repaired
    // on the way to the row, and the frame has to carry the repaired value
    // - otherwise the browser receives a compaction model with no provider
    // and silently resets the pin.
    const id = createSession('New chat', SELECTION);
    const events = [];
    const unsubscribe = subscribeSessionEvents((event) => events.push(event));

    try {
      updateSessionSelection(id, {
        model: 'minimax-m3.1-flash',
        providerId: 'minimax',
        compaction: { kind: 'explicit', model: 'cheap-compactor' },
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0].compaction).toStrictEqual(INHERIT_DEFAULT);
  });
});

describe('a compaction pin that names a removed provider (A3)', () => {
  const providers = [{ id: 'openai' }, { id: 'minimax' }];

  test.each([
    ['an explicit pin on a configured provider', explicit('cheap', 'openai'), providers, null],
    ['an explicit pin on a removed provider', explicit('cheap', 'gone'), providers, 'gone'],
    ['inherit-default names no provider', INHERIT_DEFAULT, providers, null],
    ['same-as-main names no provider', SAME_AS_MAIN, providers, null],
    // An empty list is "not loaded yet" (or nothing configured), never "all removed".
    ['an empty provider list is not evidence of removal', explicit('cheap', 'gone'), [], null],
  ])('%s', (_name, compaction, list, expected) => {
    expect(danglingCompactionProviderId(compaction, list)).toBe(expected);
  });

  describe('the repair plan the page acts on', () => {
    const onScreen = {
      currentSessionId: 7,
      compaction: explicit('cheap', 'gone'),
      providers,
      model: 'gpt-5',
      activeProviderId: 'openai',
      reasoningEffort: 'high',
      compactionReasoningEffort: undefined,
    };

    test('resets only the compaction and carries everything else over', () => {
      expect(planCompactionRepair(onScreen)).toStrictEqual({
        sessionId: 7,
        missingProviderId: 'gone',
        selection: {
          model: 'gpt-5',
          providerId: 'openai',
          compaction: INHERIT_DEFAULT,
          reasoningEffort: 'high',
          compactionReasoningEffort: null,
        },
      });
    });

    test.each([
      ['a new chat has no pin to lose', { currentSessionId: null }],
      ['a pin on a configured provider', { compaction: explicit('cheap', 'openai') }],
      ['the providers have not loaded', { providers: [] }],
      ['an inherited compaction', { compaction: INHERIT_DEFAULT }],
    ])('plans nothing when %s', (_name, change) => {
      expect(planCompactionRepair({ ...onScreen, ...change })).toBeNull();
    });

    test('once repaired, the same state plans nothing again (no loop)', () => {
      const plan = planCompactionRepair(onScreen);
      expect(
        planCompactionRepair({ ...onScreen, compaction: plan.selection.compaction })
      ).toBeNull();
    });
  });

  test('resetting the pin through APPLY_SESSION_SELECTION fixes the row AND the screen', () => {
    // The repair needs no action of its own: APPLY patches the row and, for
    // the conversation on screen, the mirror.
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [
        row(1, { compaction_model: 'cheap', compaction_provider_id: 'gone' }),
        row(2, { compaction_model: 'cheap', compaction_provider_id: 'gone' }),
      ],
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    expect(state.compaction).toStrictEqual(explicit('cheap', 'gone'));

    state = chatReducer(state, {
      type: 'APPLY_SESSION_SELECTION',
      sessionId: 1,
      selection: {
        model: state.model,
        providerId: state.activeProviderId,
        compaction: INHERIT_DEFAULT,
        reasoningEffort: state.reasoningEffort ?? null,
        compactionReasoningEffort: state.compactionReasoningEffort ?? null,
      },
    });

    expect(state.compaction).toStrictEqual(INHERIT_DEFAULT);
    const rowOne = state.sessions.find((s) => s.id === 1);
    expect(rowOne.compaction_model).toBeNull();
    expect(rowOne.compaction_provider_id).toBeNull();
    // A conversation that is not on screen is left alone until it is opened.
    expect(state.sessions.find((s) => s.id === 2).compaction_provider_id).toBe('gone');
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
    expect(state.compaction).toStrictEqual(INHERIT_DEFAULT);

    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 2 });
    expect(state.model).toBe('gpt-5');
    expect(state.activeProviderId).toBe('openai');
  });

  test('a conversation keeps its own compaction selection', () => {
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, { compaction_model: 'cheap', compaction_provider_id: 'openai' })],
    });

    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    expect(state.compaction).toStrictEqual(explicit('cheap', 'openai'));
  });

  test('switching conversations switches the reasoning levels with them', () => {
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [
        row(1, { reasoning_effort: 'high', compaction_reasoning_effort: 'low' }),
        row(2, { reasoning_effort: 'minimal', compaction_reasoning_effort: 'max' }),
      ],
    });

    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    expect(state.reasoningEffort).toBe('high');
    expect(state.compactionReasoningEffort).toBe('low');

    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 2 });
    expect(state.reasoningEffort).toBe('minimal');
    expect(state.compactionReasoningEffort).toBe('max');
  });

  test('a legacy row with no level keeps inheriting the default', () => {
    // NULL is a real state, not a value to resolve into the mirror: the
    // display falls back to the default, and a later default change must
    // reach this conversation.
    let state = chatReducer(initialState, {
      type: 'SET_CONFIG',
      config: { defaultReasoningEffort: 'low', defaultCompactionReasoningEffort: 'low' },
    });
    state = chatReducer(state, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {})],
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });

    expect(state.reasoningEffort).toBeNull();
    expect(state.defaultReasoningEffort).toBe('low');

    // The default changes; the pin stays NULL, so the display follows the
    // new default.
    state = chatReducer(state, {
      type: 'SET_CONFIG',
      config: { defaultReasoningEffort: 'high', defaultCompactionReasoningEffort: 'high' },
    });
    expect(state.reasoningEffort).toBeNull();
    expect(state.defaultReasoningEffort).toBe('high');

    // A stale session list must not pin the conversation to the old value.
    state = chatReducer(state, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {})],
    });
    expect(state.sessions[0].reasoning_effort).toBeNull();
  });

  test('a session list does not unpin a level the conversation has', () => {
    // The conversation's row has a model but no level of its own, so the
    // mirror's pin is null. Another tab picks a level and the next list
    // carries it. The mirror's null must not be written over it: the
    // conversation would silently fall back to the default until it was
    // opened again.
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {})],
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    expect(state.model).toBe('minimax-m3.1-flash');
    expect(state.reasoningEffort).toBeNull();

    state = chatReducer(state, {
      type: 'SET_SESSIONS',
      sessions: [row(1, { reasoning_effort: 'high' })],
    });
    expect(state.sessions[0].reasoning_effort).toBe('high');
  });

  test('a pinned level survives a change of the default', () => {
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, { reasoning_effort: 'low' })],
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });
    state = chatReducer(state, {
      type: 'SET_CONFIG',
      config: { defaultReasoningEffort: 'high' },
    });

    expect(state.reasoningEffort).toBe('low');
    expect(state.defaultReasoningEffort).toBe('high');
  });

  test('a reasoning pick updates only its own default', () => {
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {})],
      // The global defaults before the pick.
    });
    state = chatReducer(state, {
      type: 'SET_CONFIG',
      config: {
        defaultReasoningEffort: 'off',
        defaultCompactionReasoningEffort: 'medium',
      },
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });

    state = chatReducer(state, {
      type: 'SET_SESSION_SELECTION',
      selection: {
        model: 'minimax-m3.1-flash',
        providerId: 'minimax',
        compaction: INHERIT_DEFAULT,
        reasoningEffort: 'high',
        compactionReasoningEffort: null,
      },
      defaults: {
        model: state.defaultModel,
        providerId: state.defaultProviderId,
        compactionModel: state.defaultCompactionModel,
        reasoningEffort: 'high',
        compactionReasoningEffort: state.defaultCompactionReasoningEffort,
      },
    });

    expect(state.reasoningEffort).toBe('high');
    expect(state.defaultReasoningEffort).toBe('high');
    // The compaction level was not touched.
    expect(state.compactionReasoningEffort).toBeNull();
    expect(state.defaultCompactionReasoningEffort).toBe('medium');
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
        compaction: INHERIT_DEFAULT,
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

  test('a pick of the compaction selection writes the whole selection', () => {
    // The conversation's own row carries the union, so a pick of the
    // compaction model cannot leave the provider behind.
    let state = chatReducer(initialState, {
      type: 'SET_SESSIONS',
      sessions: [row(1, {})],
    });
    state = chatReducer(state, { type: 'SET_CURRENT_SESSION', id: 1 });

    state = chatReducer(state, {
      type: 'SET_SESSION_SELECTION',
      selection: {
        model: 'minimax-m3.1-flash',
        providerId: 'minimax',
        compaction: explicit('cheap-compactor', 'openai'),
      },
      defaults: {
        model: state.defaultModel,
        providerId: state.defaultProviderId,
        compactionModel: 'cheap-compactor',
        compactionProviderId: 'openai',
      },
    });

    expect(state.compaction).toStrictEqual(explicit('cheap-compactor', 'openai'));
    expect(state.sessions[0].compaction_model).toBe('cheap-compactor');
    expect(state.sessions[0].compaction_provider_id).toBe('openai');
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
        compaction: INHERIT_DEFAULT,
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
        compaction: INHERIT_DEFAULT,
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

  test('a session list does not erase a conversation’s model while the mirror has none', () => {
    // The conversation was opened before its row arrived, so the mirror has
    // no model yet. The list carries the server's model, and it must reach
    // the row: writing the empty mirror into it would erase the model the
    // server has.
    let state = chatReducer(initialState, { type: 'SET_CURRENT_SESSION', id: 1 });
    expect(state.model).toBe('');

    state = chatReducer(state, {
      type: 'SET_SESSIONS',
      sessions: [row(1, { model: 'conversation-model', provider_id: 'p1' })],
    });
    expect(state.sessions[0].model).toBe('conversation-model');
    expect(state.sessions[0].provider_id).toBe('p1');
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
        compaction: INHERIT_DEFAULT,
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
        compaction: INHERIT_DEFAULT,
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
        compaction: INHERIT_DEFAULT,
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
      compaction: SAME_AS_MAIN,
      reasoningEffort: 'high',
      compactionReasoningEffort: null,
    });

    expect(parseSessionEvent(frame)).toStrictEqual({
      kind: 'model-changed',
      sessionId: 29,
      selection: {
        model: 'gpt-5',
        providerId: 'openai',
        compaction: SAME_AS_MAIN,
        reasoningEffort: 'high',
        compactionReasoningEffort: null,
      },
    });
  });

  test('a frame whose compaction selection is missing or unusable is IGNORED and reported', () => {
    // The server always announces the pair it wrote, so such a frame is a
    // server bug. Reading it as "inherit the global default" would silently
    // overwrite the compaction model the user pinned (bug hunt A2).
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const base = { kind: 'model-changed', sessionId: 29, model: 'gpt-5', providerId: null };
      // Absent, a half-pair (a model with no provider), and a legacy flat pair.
      for (const extra of [
        {},
        { compaction: { kind: 'explicit', model: 'beam' } },
        { compactionModel: 'beam', compactionProviderId: 'ollama-cloud' },
      ]) {
        expect(parseSessionEvent(JSON.stringify({ ...base, ...extra }))).toBeNull();
      }
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[0][0]).toContain('conversation 29');
      expect(warn.mock.calls[1][0]).toContain('"beam"');
    } finally {
      warn.mockRestore();
    }
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

describe('the compaction selection is ONE value — the half-pair cannot exist', () => {
  test('a model with no provider is refused, not repaired', () => {
    // The state that sent a compaction model to an endpoint that did not
    // have it. It is refused at the boundary, with a message that says what
    // to send instead.
    const parsed = parseCompactionSelection({ kind: 'explicit', model: 'cheap-compactor' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('cheap-compactor');
  });

  test('a provider with no model is refused too', () => {
    const parsed = parseCompactionSelection({ kind: 'explicit', providerId: 'openai' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('names no model');
    expect(parsed.error).toContain('together');
  });

  test('an unknown kind is refused', () => {
    const parsed = parseCompactionSelection({ kind: 'half-a-pair' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('compaction must be one of');
  });

  test('the three legal states pass', () => {
    expect(parseCompactionSelection(INHERIT_DEFAULT)).toStrictEqual({
      ok: true,
      selection: INHERIT_DEFAULT,
    });
    expect(parseCompactionSelection(SAME_AS_MAIN)).toStrictEqual({
      ok: true,
      selection: SAME_AS_MAIN,
    });
    expect(parseCompactionSelection(explicit('cheap-compactor', 'openai'))).toStrictEqual({
      ok: true,
      selection: explicit('cheap-compactor', 'openai'),
    });
  });

  test('a row can never hold a compaction model without its provider', async () => {
    // The pair is normalised on the way OUT of the projection, so the
    // illegal combination cannot reach the row even if a caller built one
    // by hand.
    //
    // The assertion is on the RAW row. `listSessions()` REPAIRS the pair on
    // the way out, so asserting on it would pass even while the row held
    // the illegal combination - which is exactly what it used to do.
    const id = createSession('New chat', {
      ...SELECTION,
      compaction: { kind: 'explicit', model: 'cheap-compactor' },
    });

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(root, 'locopilot.db'));
    let row;
    try {
      row = db
        .prepare('SELECT compaction_model, compaction_provider_id FROM sessions WHERE id = ?')
        .get(id);
    } finally {
      db.close();
    }

    expect(row.compaction_model).toBeNull();
    expect(row.compaction_provider_id).toBeNull();
  });

  test('an explicit selection is stored as a pair', () => {
    const id = createSession('New chat', {
      ...SELECTION,
      compaction: explicit('cheap-compactor', 'openai'),
    });

    const stored = listSessions().find((s) => s.id === id);
    expect(stored.compaction_model).toBe('cheap-compactor');
    expect(stored.compaction_provider_id).toBe('openai');
  });

  test('a row that already holds a half-pair is normalised on the way out', async () => {
    // A row written before the pair was one value can still hold a model
    // with no provider. It is repaired on READ, so no caller — the browser
    // included — ever sees the illegal combination.
    const id = createSession('New chat', SELECTION);
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(root, 'locopilot.db'));
    try {
      db.prepare(
        `UPDATE sessions SET compaction_model = ?, compaction_provider_id = ? WHERE id = ?`
      ).run('legacy-model', null, id);
    } finally {
      db.close();
    }

    const stored = listSessions().find((s) => s.id === id);
    expect(stored.compaction_model).toBeNull();
    expect(stored.compaction_provider_id).toBeNull();
    expect(getSessionSelection(id).compaction).toStrictEqual(INHERIT_DEFAULT);
  });

  test('the projection to the two columns is the only way out', () => {
    expect(compactionSelectionToPair(INHERIT_DEFAULT)).toStrictEqual({
      model: null,
      providerId: null,
    });
    expect(compactionSelectionToPair(SAME_AS_MAIN)).toStrictEqual({
      model: '',
      providerId: null,
    });
    expect(compactionSelectionToPair(explicit('m', 'p'))).toStrictEqual({
      model: 'm',
      providerId: 'p',
    });
  });
});
