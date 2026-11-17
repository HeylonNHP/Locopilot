/**
 * The cached model → provider index, and the pair check it answers.
 *
 * A selection is a (model, provider) PAIR, and the pair is only coherent
 * if the provider actually carries the model. `config.json` cannot answer
 * that question, so the server keeps the providers' LIVE model lists in a
 * cache and asks them.
 *
 * What is pinned:
 *   - a listed model is "served", an unlisted one is "not served";
 *   - "unknown" NEVER refuses — a cold cache, a failed fetch and an empty
 *     list all answer "unknown";
 *   - the Ollama tag tolerance: `llama3` names `llama3:latest`;
 *   - the pair check refuses with a message that names the provider that
 *     DOES serve the model.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

import {
  compactionProblemFor,
  configProblemFor,
} from '../src/services/contextWindow/configProblem.ts';
import {
  invalidateModelIndex,
  peekProviderModels,
  providerIdsServingModel,
  providerServesModel,
  recordProviderListFailure,
  recordProviderModels,
  setModelIndexDeps,
} from '../src/services/modelIndex.ts';
import { resolveProvider } from '../src/services/providerResolver.ts';

const provider = (extra = {}) => ({
  id: 'p1',
  name: 'P',
  provider: 'ollama',
  baseUrl: 'http://p1',
  model: 'beam',
  ...extra,
});

const config = {
  numCtx: 131_072,
  providers: [
    provider({ id: 'p1', name: 'NVIDIA', baseUrl: 'http://p1', model: 'beam' }),
    provider({ id: 'p2', name: 'Ollama Cloud', baseUrl: 'http://p2', model: 'llama3' }),
  ],
};

beforeAll(() => {
  // The background refresh must never reach for a provider during a test.
  setModelIndexDeps({ fetchModels: async () => [] });
});

afterAll(() => {
  setModelIndexDeps(null);
});

beforeEach(() => {
  invalidateModelIndex();
});

describe('the index answers whether a provider serves a model', () => {
  test('a listed model is served', () => {
    recordProviderModels('p1', 'http://p1', ['beam', 'other']);
    expect(providerServesModel('p1', 'http://p1', 'beam')).toBe('served');
    expect(providerServesModel('p1', 'http://p1', 'other')).toBe('served');
  });

  test('a model the provider does not list is not served', () => {
    recordProviderModels('p1', 'http://p1', ['beam']);
    expect(providerServesModel('p1', 'http://p1', 'llama3')).toBe('not-served');
  });

  test('the Ollama tag tolerance: `llama3` names `llama3:latest`', () => {
    recordProviderModels('p2', 'http://p2', ['llama3:latest', 'qwen3:8b']);
    expect(providerServesModel('p2', 'http://p2', 'llama3')).toBe('served');
    expect(providerServesModel('p2', 'http://p2', 'llama3:latest')).toBe('served');
    expect(providerServesModel('p2', 'http://p2', 'qwen3')).toBe('served');
    expect(providerServesModel('p2', 'http://p2', 'qwen3:8b')).toBe('served');
  });

  test('a provider that was never listed is unknown, not "not served"', () => {
    expect(providerServesModel('p1', 'http://p1', 'beam')).toBe('unknown');
  });

  test('a failed fetch is unknown, not "serves nothing"', () => {
    // An empty list would say "this provider serves nothing", which is a
    // refusal — and a lie.
    recordProviderListFailure('p1', 'http://p1');
    expect(providerServesModel('p1', 'http://p1', 'beam')).toBe('unknown');
    expect(peekProviderModels('p1', 'http://p1')).toBeNull();
  });

  test('an empty list is unknown too', () => {
    recordProviderModels('p1', 'http://p1', []);
    expect(providerServesModel('p1', 'http://p1', 'beam')).toBe('unknown');
  });

  test('the address is part of the key, so a moved provider knows nothing', () => {
    recordProviderModels('p1', 'http://p1', ['beam']);
    expect(providerServesModel('p1', 'http://p2', 'beam')).toBe('unknown');
  });

  test('the providers that serve a model are found by id', () => {
    recordProviderModels('p1', 'http://p1', ['beam']);
    recordProviderModels('p2', 'http://p2', ['beam']);
    expect(providerIdsServingModel(config, 'beam')).toEqual(['p1', 'p2']);
    expect(providerIdsServingModel(config, 'nothing')).toEqual([]);
  });

  test('invalidating a provider drops what was known about it', () => {
    recordProviderModels('p1', 'http://p1', ['beam']);
    invalidateModelIndex('p1');
    expect(providerServesModel('p1', 'http://p1', 'beam')).toBe('unknown');
  });
});

describe('a pair whose provider does not serve the model is refused', () => {
  test('the refusal names the provider that does serve it', () => {
    recordProviderModels('p1', 'http://p1', ['beam']);
    recordProviderModels('p2', 'http://p2', ['llama3']);

    // The pair is fine: `llama3` is in Ollama Cloud's list.
    expect(configProblemFor(config, 'p2', 'llama3')).toBeNull();

    // `llama3` is NOT in NVIDIA's list, but Ollama Cloud serves it.
    const refusal = configProblemFor(config, 'p1', 'llama3');
    expect(refusal).toMatch(/does not serve the model "llama3"/);
    expect(refusal).toMatch(/Ollama Cloud/);
    expect(refusal).not.toMatch(/The provider "Ollama Cloud"/);
  });

  test('the refusal names the provider that does NOT serve it', () => {
    recordProviderModels('p1', 'http://p1', ['beam']);
    const refusal = configProblemFor(config, 'p1', 'llama3');
    expect(refusal).toMatch(/The provider "NVIDIA" does not serve the model "llama3"/);
  });

  test('with no index the pair cannot be checked, and nothing is refused', () => {
    // Fail open: an index that cannot say must never break a turn.
    expect(configProblemFor(config, 'p1', 'llama3')).toBeNull();
  });

  test('two providers with the same name do not hide the one that serves the model', () => {
    // The offending provider is excluded from the hint by its ID: two
    // providers may share a name, and excluding by name would drop the
    // serving one too - the message would then say that NOBODY serves the
    // model when one of them does.
    const duplicates = {
      numCtx: 131_072,
      providers: [
        provider({ id: 'p1', name: 'Same Name', baseUrl: 'http://p1', model: 'other' }),
        provider({ id: 'p2', name: 'Same Name', baseUrl: 'http://p2', model: undefined }),
      ],
    };
    recordProviderModels('p1', 'http://p1', ['other']);
    recordProviderModels('p2', 'http://p2', ['beam']);

    const refusal = configProblemFor(duplicates, 'p1', 'beam');
    expect(refusal).toMatch(/does not serve the model "beam"/);
    expect(refusal).toMatch(/served by Same Name instead/);
    expect(refusal).not.toMatch(/No configured provider is known to serve it/);
  });
});

describe('an inherited global compaction model is checked against the provider the CHAT runs on', () => {
  // The production incident (CONFIRMATIONS C-025): the global compaction
  // model was `beam`, an Ollama Cloud model, and the global config had NO
  // way to say which provider served it. So the compaction call went to the
  // main chat provider (NVIDIA), which does not serve `beam`, and answered
  // HTTP 404 - 221 times in 14 minutes under one request id.
  //
  // The shape here is the owner's: `ollama-cloud` has NO `model` field in
  // config.json, so it never wins a model-name match.
  const NVIDIA = provider({ id: 'p1', name: 'NVIDIA', baseUrl: 'http://p1', model: 'llama3' });
  const CLOUD = provider({
    id: 'p2',
    name: 'Ollama Cloud',
    baseUrl: 'http://p2',
    model: undefined,
  });

  const globalConfig = {
    numCtx: 131_072,
    compactionModel: 'beam',
    compactionProviderId: null,
    providers: [NVIDIA, CLOUD],
  };

  test('a global compaction model the MAIN provider does not serve is REFUSED', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);
    recordProviderModels('p2', 'http://p2', ['beam']);

    const refusal = compactionProblemFor(globalConfig, {
      mainModel: 'llama3',
      mainProvider: resolveProvider(globalConfig, 'p1', 'llama3'),
      compaction: { kind: 'inherit-default' },
    });

    expect(refusal).toMatch(/The compaction model "beam" has no provider of its own/);
    expect(refusal).toMatch(/"NVIDIA"/);
    // the fix is one pick, so the message names the provider that DOES serve it
    expect(refusal).toMatch(/Ollama Cloud/);
  });

  test('the check is made against the provider the CHAT runs on, not against providers[0]', () => {
    // The trap: `ollama-cloud` has no default model, so a resolution that
    // dropped the request's provider id would land on `providers[0]`
    // (NVIDIA) and refuse a turn that works.
    recordProviderModels('p1', 'http://p1', ['llama3']);
    recordProviderModels('p2', 'http://p2', ['beam']);

    expect(resolveProvider(globalConfig, undefined, 'llama3')?.id).toBe('p1');

    expect(
      compactionProblemFor(globalConfig, {
        mainModel: 'llama3',
        mainProvider: resolveProvider(globalConfig, 'p2', 'llama3'),
        compaction: { kind: 'inherit-default' },
      })
    ).toBeNull();
  });

  test('a global compaction model the MAIN provider DOES serve runs', () => {
    recordProviderModels('p2', 'http://p2', ['beam']);

    expect(
      compactionProblemFor(globalConfig, {
        mainModel: 'llama3',
        mainProvider: resolveProvider(globalConfig, 'p2', 'llama3'),
        compaction: { kind: 'inherit-default' },
      })
    ).toBeNull();
  });

  test('a COLD index never refuses - the pair is trusted until it can be checked', () => {
    // Fail open: an index that cannot say must never block a turn.
    expect(
      compactionProblemFor(globalConfig, {
        mainModel: 'llama3',
        mainProvider: resolveProvider(globalConfig, 'p1', 'llama3'),
        compaction: { kind: 'inherit-default' },
      })
    ).toBeNull();
  });

  test('"same as the main model" is NOT checked again - the main pair check covered it', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);

    expect(
      compactionProblemFor(globalConfig, {
        mainModel: 'llama3',
        mainProvider: resolveProvider(globalConfig, 'p1', 'llama3'),
        compaction: { kind: 'same-as-main' },
      })
    ).toBeNull();
  });

  test('no global compaction model - the main model on the main provider - is NOT checked again', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);

    expect(
      compactionProblemFor(
        { ...globalConfig, compactionModel: '' },
        {
          mainModel: 'llama3',
          mainProvider: resolveProvider(globalConfig, 'p1', 'llama3'),
          compaction: { kind: 'inherit-default' },
        }
      )
    ).toBeNull();
  });

  test('an EXPLICIT compaction pair is checked against ITS OWN provider, not the main one', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);
    recordProviderModels('p2', 'http://p2', ['beam']);

    // The main provider does NOT serve `beam`; the explicit pair names the
    // provider that does, and its own check covers it.
    expect(
      compactionProblemFor(globalConfig, {
        mainModel: 'llama3',
        mainProvider: resolveProvider(globalConfig, 'p1', 'llama3'),
        compaction: { kind: 'explicit', model: 'beam', providerId: 'p2' },
      })
    ).toBeNull();
  });

  test('the global pair WITH a provider is still refused when that provider does not serve the model', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);

    const refusal = compactionProblemFor(
      { ...globalConfig, compactionProviderId: 'p1' },
      {
        mainModel: 'llama3',
        mainProvider: resolveProvider(globalConfig, 'p1', 'llama3'),
        compaction: { kind: 'inherit-default' },
      }
    );
    expect(refusal).toMatch(/does not serve the model "beam"/);
  });

  test('a global provider id that names no configured provider is still refused by the composer', () => {
    // Not double-handled: the composer owns this refusal.
    const refusal = compactionProblemFor(
      { ...globalConfig, compactionProviderId: 'gone' },
      {
        mainModel: 'llama3',
        mainProvider: resolveProvider(globalConfig, 'p1', 'llama3'),
        compaction: { kind: 'inherit-default' },
      }
    );
    expect(refusal).toContain('global compaction provider');
  });

  test('no main provider - nothing to check the pair against, and nothing is refused', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);

    expect(
      compactionProblemFor(globalConfig, {
        mainModel: 'llama3',
        mainProvider: null,
        compaction: { kind: 'inherit-default' },
      })
    ).toBeNull();
  });
});
