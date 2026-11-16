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

import { configProblemFor } from '../src/services/contextWindow/configProblem.ts';
import {
  invalidateModelIndex,
  peekProviderModels,
  providerIdsServingModel,
  providerServesModel,
  recordProviderListFailure,
  recordProviderModels,
  setModelIndexDeps,
} from '../src/services/modelIndex.ts';

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
});
