/**
 * Tests for the compaction selection — the rule and the server composer.
 *
 * WHY this exists: the compaction model and the compaction provider used to
 * be resolved in four places (the chat route's preflight, the chat route's
 * runtime, the compact route and the title route) and the four did not
 * agree. Two resolved the provider by ID *and* by model name, so a provider
 * id that no longer existed silently became "whatever provider owns that
 * model name" — with that provider's API key. The other two resolved by ID
 * only, so the same stale id silently became "the main chat provider". Both
 * wrong answers were invisible: the compaction call went to an endpoint that
 * does not serve the model and came back 404, and the caller carried on.
 *
 * The rule now lives in ONE place (`src/services/compactionRule.ts`) and the
 * server composer around it (`src/services/compactionSelection.ts`) adds the
 * config lookup and the ONE refusal. These tests pin:
 *
 *  - the rule's table (who wins for the model, who wins for the provider),
 *  - the invariant that produced the 404s — a model is never handed to a
 *    provider that was pinned for a different model,
 *  - the refusal: a provider id that names no configured provider is a
 *    PROBLEM (409), not a reason to fall back.
 *
 * THE COMPACTION PAIR IS ONE VALUE. It used to be two independent nullable
 * fields, which admitted a model WITHOUT the provider that serves it — the
 * exact state that sent a compaction model to an endpoint that did not have
 * it. It is now a union with THREE states (`CompactionSelection`):
 * `inherit-default`, `same-as-main` and `explicit` (a model AND a
 * provider). The half-pair is not represented, so it cannot be produced by
 * a caller, stored in a row, or resolved by the rule.
 *
 * The rule module is deliberately dependency-free, so the browser and the
 * server can share it; the composer is server-only (it reads the provider
 * list). Both are exercised here.
 */

import { describe, expect, test } from '@jest/globals';

import { resolveCompactionRule } from '../src/services/compactionRule.ts';
import { resolveCompactionSelection } from '../src/services/compactionSelection.ts';
import {
  compactionSelectionFromLoosePair,
  compactionSelectionFromPair,
} from '../src/services/sessionSelection.ts';

const MAIN_MODEL = 'main-model';

/** The three legal states of the conversation's own compaction selection. */
const INHERIT_DEFAULT = { kind: 'inherit-default' };
const SAME_AS_MAIN = { kind: 'same-as-main' };
const explicit = (model, providerId) => ({ kind: 'explicit', model, providerId });

/** A config with two providers, so "by id" and "by model name" can differ. */
function buildConfig(overrides = {}) {
  return {
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com',
        model: 'gpt-main',
      },
      {
        id: 'ollama',
        name: 'Ollama',
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'llama-local',
      },
    ],
    ...overrides,
  };
}

describe('resolveCompactionRule — the model', () => {
  test("a conversation pinned to the main model runs on its own main model", () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: SAME_AS_MAIN,
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.model).toBe(MAIN_MODEL);
    expect(result.modelSource).toBe('session-main');
  });

  test('a conversation that pinned a model keeps it', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: explicit('session-model', 'ollama'),
    });
    expect(result.model).toBe('session-model');
    expect(result.modelSource).toBe('session');
  });

  test('a conversation that pinned nothing inherits the global model', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: INHERIT_DEFAULT,
      globalCompactionModel: 'global-model',
    });
    expect(result.model).toBe('global-model');
    expect(result.modelSource).toBe('global');
  });

  test('with no global default either, the conversation runs on its main model', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: INHERIT_DEFAULT,
      globalCompactionModel: '',
    });
    expect(result.model).toBe(MAIN_MODEL);
    expect(result.modelSource).toBe('main');
  });

  test('an absent session selection is the same as an explicit inherit', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      globalCompactionModel: 'global-model',
    });
    expect(result.model).toBe('global-model');
    expect(result.modelSource).toBe('global');
  });
});

describe('resolveCompactionRule — the provider', () => {
  test("'same as the main model' runs on the MAIN provider, never on a pin", () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: SAME_AS_MAIN,
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
  });

  test("a conversation's own provider pin wins outright", () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: explicit('session-model', 'ollama'),
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'openai',
    });
    expect(result.providerId).toBe('ollama');
    expect(result.providerSource).toBe('session');
  });

  test('the global model runs on the global provider', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: INHERIT_DEFAULT,
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBe('ollama');
    expect(result.providerSource).toBe('global');
  });

  test('the global model with no global provider runs on the main provider', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: INHERIT_DEFAULT,
      globalCompactionModel: 'global-model',
    });
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
  });

  test('a conversation with no compaction model at all runs on the main provider', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: INHERIT_DEFAULT,
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
  });

  test('a global provider with no global model does not apply', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: INHERIT_DEFAULT,
      globalCompactionModel: '',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
  });
});

describe('resolveCompactionRule — a model is never handed to the wrong endpoint', () => {
  test("a conversation's own model of its own runs on ITS provider, never the global one", () => {
    // This is the case that produced the production 404s: a cloud model
    // named globally, served by one provider, ended up at another provider
    // because the id no longer matched and the model name matched nothing.
    // The selection names its own provider, so it CANNOT drift.
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: explicit('some-other-model', 'openai'),
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.model).toBe('some-other-model');
    expect(result.providerId).toBe('openai');
    expect(result.providerSource).toBe('session');
  });

  test('the global provider is used only with the global model', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: INHERIT_DEFAULT,
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBe('ollama');
    expect(result.providerSource).toBe('global');
  });

  test('the global provider is not used for a different model', () => {
    // A conversation that inherits the global MODEL gets the global
    // PROVIDER with it — the pair travels together. It never borrows the
    // global provider for a model of its own, because that state cannot be
    // represented any more.
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompaction: explicit('other-model', 'openai'),
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBe('openai');
  });
});

describe('the compaction pair is ONE value — three states, no half-pairs', () => {
  test('no model and no provider means "inherit the global default"', () => {
    const parsed = compactionSelectionFromPair(null, null);
    expect(parsed.ok).toBe(true);
    expect(parsed.selection).toEqual({ kind: 'inherit-default' });
  });

  test('an empty model means "the conversation\'s own main model"', () => {
    const parsed = compactionSelectionFromPair('', null);
    expect(parsed.ok).toBe(true);
    expect(parsed.selection).toEqual({ kind: 'same-as-main' });
  });

  test('a provider sent with "same as the main model" is dropped, not refused', () => {
    // The state means the MAIN provider, so a provider sent alongside it
    // cannot apply. Refusing would break a control that sends the whole
    // pair; dropping it keeps the meaning.
    const parsed = compactionSelectionFromPair('', 'ollama');
    expect(parsed.ok).toBe(true);
    expect(parsed.selection).toEqual({ kind: 'same-as-main' });
  });

  test('a model AND a provider is an explicit selection', () => {
    const parsed = compactionSelectionFromPair('session-model', 'ollama');
    expect(parsed.ok).toBe(true);
    expect(parsed.selection).toEqual({
      kind: 'explicit',
      model: 'session-model',
      providerId: 'ollama',
    });
  });

  test('a NAMED model WITHOUT its provider is REFUSED', () => {
    // The half-pair is the bug class: the model would be handed to an
    // endpoint that was never chosen for it.
    const parsed = compactionSelectionFromPair('session-model', null);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('session-model');
  });

  test('a provider WITHOUT a model is REFUSED', () => {
    const parsed = compactionSelectionFromPair(null, 'ollama');
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('without a compaction model');
  });

  test('pins are trimmed', () => {
    const parsed = compactionSelectionFromPair('  session-model  ', '  ollama  ');
    expect(parsed.ok).toBe(true);
    expect(parsed.selection).toEqual({
      kind: 'explicit',
      model: 'session-model',
      providerId: 'ollama',
    });
  });

  test('a whitespace-only model is the empty pin', () => {
    const parsed = compactionSelectionFromPair('   ', null);
    expect(parsed.ok).toBe(true);
    expect(parsed.selection).toEqual({ kind: 'same-as-main' });
  });

  test('the lenient reader repairs a half-pair towards the global default', () => {
    // The places that must not fail — reading a stored row, showing what a
    // conversation compacts with — repair instead of refusing, and the safe
    // direction is the global default (a model AND a provider that belong
    // together).
    expect(compactionSelectionFromLoosePair('session-model', null)).toEqual({
      kind: 'inherit-default',
    });
    expect(compactionSelectionFromLoosePair(null, 'ollama')).toEqual({
      kind: 'inherit-default',
    });
    expect(compactionSelectionFromLoosePair('', null)).toEqual({ kind: 'same-as-main' });
    expect(compactionSelectionFromLoosePair('', 'ollama')).toEqual({ kind: 'same-as-main' });
  });
});

describe('resolveCompactionSelection — the server composer', () => {
  test('a configured global compaction provider resolves without complaint', () => {
    const selection = resolveCompactionSelection({
      config: buildConfig({ compactionModel: 'llama-local', compactionProviderId: 'ollama' }),
      mainModel: 'gpt-main',
    });
    expect(selection.problem).toBeNull();
    expect(selection.model).toBe('llama-local');
    expect(selection.providerId).toBe('ollama');
    expect(selection.modelSource).toBe('global');
    expect(selection.providerSource).toBe('global');
  });

  test('a global provider id that names no configured provider is REFUSED', () => {
    const selection = resolveCompactionSelection({
      config: buildConfig({ compactionModel: 'llama-local', compactionProviderId: 'gone' }),
      mainModel: 'gpt-main',
    });
    expect(selection.problem).toContain('gone');
    expect(selection.problem).toContain('global compaction provider');
  });

  test('a session provider id that names no configured provider is REFUSED', () => {
    const selection = resolveCompactionSelection({
      config: buildConfig(),
      mainModel: 'gpt-main',
      sessionCompaction: explicit('llama-local', 'gone'),
    });
    expect(selection.problem).toContain('gone');
    expect(selection.problem).toContain('not configured');
  });

  test('a provider is resolved BY ID, never by model name', () => {
    // `openai` is a configured provider but its default model is
    // `gpt-main`, not the compaction model. The id is authoritative: the
    // pair is validated against live model lists in a later phase, not by
    // guessing here.
    const selection = resolveCompactionSelection({
      config: buildConfig({ compactionModel: 'llama-local', compactionProviderId: 'openai' }),
      mainModel: 'gpt-main',
    });
    expect(selection.problem).toBeNull();
    expect(selection.providerId).toBe('openai');
  });

  test('a missing config cannot resolve a pinned provider, and says so', () => {
    const selection = resolveCompactionSelection({
      config: null,
      mainModel: 'gpt-main',
      sessionCompaction: explicit('llama-local', 'ollama'),
    });
    expect(selection.problem).not.toBeNull();
  });

  test('no pins at all resolves to the main model on the main provider', () => {
    const selection = resolveCompactionSelection({
      config: buildConfig(),
      mainModel: 'gpt-main',
    });
    expect(selection.problem).toBeNull();
    expect(selection.model).toBe('gpt-main');
    expect(selection.modelSource).toBe('main');
    expect(selection.providerId).toBeNull();
    expect(selection.providerSource).toBe('main');
  });

  test('the legacy two-field pair is still read (an older tab keeps working)', () => {
    const selection = resolveCompactionSelection({
      config: buildConfig(),
      mainModel: 'gpt-main',
      sessionCompactionModel: 'llama-local',
      sessionCompactionProviderId: 'ollama',
    });
    expect(selection.problem).toBeNull();
    expect(selection.model).toBe('llama-local');
    expect(selection.providerId).toBe('ollama');
    expect(selection.providerSource).toBe('session');
  });

  test('the legacy half-pair is REFUSED loudly, not repaired silently', () => {
    // A model without the provider that serves it is the state that sent a
    // compaction model to an endpoint that did not have it. The composer
    // refuses it rather than guessing which provider was meant.
    const selection = resolveCompactionSelection({
      config: buildConfig(),
      mainModel: 'gpt-main',
      sessionCompactionModel: 'llama-local',
      sessionCompactionProviderId: null,
    });
    expect(selection.problem).toContain('llama-local');
  });

  test('a legacy provider without a model resolves the model HERE', () => {
    // The pair travels together, so the model behind the provider is the
    // global default's model (or the main model) — resolved now, and the
    // result is EXPLICIT, so the rule cannot borrow another provider.
    const selection = resolveCompactionSelection({
      config: buildConfig({ compactionModel: 'llama-local' }),
      mainModel: 'gpt-main',
      sessionCompactionProviderId: 'ollama',
    });
    expect(selection.problem).toBeNull();
    expect(selection.model).toBe('llama-local');
    expect(selection.providerId).toBe('ollama');
    expect(selection.providerSource).toBe('session');
  });
});
