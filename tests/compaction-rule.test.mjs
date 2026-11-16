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
 * The rule module is deliberately dependency-free, so the browser and the
 * server can share it; the composer is server-only (it reads the provider
 * list). Both are exercised here.
 */

import { describe, expect, test } from '@jest/globals';

import { resolveCompactionRule } from '../src/services/compactionRule.ts';
import { resolveCompactionSelection } from '../src/services/compactionSelection.ts';

const MAIN_MODEL = 'main-model';

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
  test("a conversation pinned to '' runs on its own main model", () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: '',
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.model).toBe(MAIN_MODEL);
    expect(result.modelSource).toBe('session-main');
  });

  test('a conversation that pinned a model keeps it', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: 'session-model',
    });
    expect(result.model).toBe('session-model');
    expect(result.modelSource).toBe('session');
  });

  test('a conversation that pinned nothing inherits the global model', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: null,
      globalCompactionModel: 'global-model',
    });
    expect(result.model).toBe('global-model');
    expect(result.modelSource).toBe('global');
  });

  test('with no global default either, the conversation runs on its main model', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: null,
      globalCompactionModel: '',
    });
    expect(result.model).toBe(MAIN_MODEL);
    expect(result.modelSource).toBe('main');
  });

  test('an absent session pin is the same as an explicit null', () => {
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
      sessionCompactionModel: '',
      sessionCompactionProviderId: 'ollama',
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
  });

  test("a conversation's own provider pin wins outright", () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: 'session-model',
      sessionCompactionProviderId: 'ollama',
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'openai',
    });
    expect(result.providerId).toBe('ollama');
    expect(result.providerSource).toBe('session');
  });

  test('the global model runs on the global provider', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBe('ollama');
    expect(result.providerSource).toBe('global');
  });

  test('the global model with no global provider runs on the main provider', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      globalCompactionModel: 'global-model',
    });
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
  });

  test('a conversation with no compaction model at all runs on the main provider', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: null,
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
  });

  test('a global provider with no global model does not apply', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      globalCompactionModel: '',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
  });
});

describe('resolveCompactionRule — a model is never handed to the wrong endpoint', () => {
  test("a conversation's model of its own does NOT borrow the global provider", () => {
    // This is the case that produced the production 404s: a cloud model
    // named globally, served by one provider, ended up at another provider
    // because the id no longer matched and the model name matched nothing.
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: 'some-other-model',
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.model).toBe('some-other-model');
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
  });

  test('the global provider IS used when it serves that very same model', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: 'global-model',
      globalCompactionModel: 'global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBe('ollama');
    expect(result.providerSource).toBe('global');
  });

  test('the global provider is not used for a different model even when it is the same name', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: 'global-model',
      globalCompactionModel: 'other-global-model',
      globalCompactionProviderId: 'ollama',
    });
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
  });
});

describe('resolveCompactionRule — input hygiene', () => {
  test('pins are trimmed', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: '  session-model  ',
      sessionCompactionProviderId: '  ollama  ',
    });
    expect(result.model).toBe('session-model');
    expect(result.providerId).toBe('ollama');
  });

  test('a whitespace-only session pin trims to the empty pin', () => {
    // An empty pin is "same as the conversation's own main model", which is
    // the SAFE answer: it can never send a model to an endpoint that does
    // not serve it.
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: '   ',
      globalCompactionModel: 'global-model',
    });
    expect(result.model).toBe(MAIN_MODEL);
    expect(result.modelSource).toBe('session-main');
  });

  test('a whitespace-only provider pin is not a pin', () => {
    const result = resolveCompactionRule({
      mainModel: MAIN_MODEL,
      sessionCompactionModel: 'session-model',
      sessionCompactionProviderId: '   ',
    });
    expect(result.providerId).toBeNull();
    expect(result.providerSource).toBe('main');
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
      sessionCompactionModel: 'llama-local',
      sessionCompactionProviderId: 'gone',
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
      sessionCompactionModel: 'llama-local',
      sessionCompactionProviderId: 'ollama',
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
});
