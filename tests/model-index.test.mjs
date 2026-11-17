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

import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
  compactionProblemFor,
  configProblemFor,
  planModelSwitch,
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

describe('a mid-turn model switch is checked against the pair it would form', () => {
  // The switch is the only path that introduces a NEW (model, provider) pair
  // while a turn is running, and it used to be the only UNCHECKED one: the
  // route accepted any provider id and the turn applied it without asking
  // whether the provider carries the model. That is how the global
  // compaction model "beam" still reached NVIDIA (CONFIRMATIONS C-025).
  const NVIDIA = provider({ id: 'p1', name: 'NVIDIA', baseUrl: 'http://p1', model: 'llama3' });
  const CLOUD = provider({
    id: 'p2',
    name: 'Ollama Cloud',
    baseUrl: 'http://p2',
    model: undefined,
  });

  const switchConfig = {
    numCtx: 131_072,
    providers: [NVIDIA, CLOUD],
  };

  /** The switch as the turn sees it: it runs on the cloud provider. */
  const onCloud = {
    currentModel: 'llama3',
    currentProviderId: 'p2',
    currentCompaction: { kind: 'inherit-default' },
  };

  test('a switch onto a provider that does not serve the model is REFUSED', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);
    recordProviderModels('p2', 'http://p2', ['llama3', 'beam']);

    // The switch would run "beam" on NVIDIA, which does not serve it.
    const plan = planModelSwitch(switchConfig, {
      ...onCloud,
      model: 'beam',
      providerId: 'p1',
    });
    expect(plan.ok).toBe(false);
    expect(plan.problem).toMatch(/does not serve the model "beam"/);
  });

  test('a switch onto a provider that DOES serve the model is honoured', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);
    recordProviderModels('p2', 'http://p2', ['llama3', 'beam']);

    // The same switch, but Ollama Cloud is the one that serves "beam".
    const plan = planModelSwitch(switchConfig, {
      ...onCloud,
      model: 'beam',
      providerId: 'p2',
    });
    expect(plan.ok).toBe(true);
    expect(plan.target.provider.id).toBe('p2');
    expect(plan.target.model).toBe('beam');
  });

  test('a model-only switch keeps the provider the turn already runs on', () => {
    // The cross-wire that C-027 removed everywhere else: a model-only
    // switch used to recover a provider by MODEL NAME, and NVIDIA's
    // default model IS "beam" here - so the old behaviour moved the turn
    // to NVIDIA, with NVIDIA's apiKey, while the user only asked for a
    // different model.
    const trap = {
      numCtx: 131_072,
      providers: [
        provider({ id: 'p1', name: 'NVIDIA', baseUrl: 'http://p1', model: 'beam' }),
        provider({ id: 'p2', name: 'Ollama Cloud', baseUrl: 'http://p2', model: undefined }),
      ],
    };
    recordProviderModels('p1', 'http://p1', ['beam']);
    recordProviderModels('p2', 'http://p2', ['llama3', 'beam']);

    // the trap: the model name alone names NVIDIA
    expect(resolveProvider(trap, undefined, 'beam')?.id).toBe('p1');

    const plan = planModelSwitch(trap, {
      ...onCloud,
      model: 'beam',
    });
    expect(plan.ok).toBe(true);
    expect(plan.target.model).toBe('beam');
    expect(plan.target.provider.id).toBe('p2');
  });

  test('a switch that would strand the global compaction model on a provider that does not serve it is REFUSED', () => {
    // THE PRODUCTION CASE: the global compaction model is "beam" with no
    // global compaction provider, so the compaction runs on the provider
    // the switch moves the turn to. NVIDIA does not serve "beam".
    recordProviderModels('p1', 'http://p1', ['llama3']);
    recordProviderModels('p2', 'http://p2', ['llama3', 'beam']);

    const plan = planModelSwitch(
      { ...switchConfig, compactionModel: 'beam', compactionProviderId: null },
      { ...onCloud, providerId: 'p1' }
    );
    expect(plan.ok).toBe(false);
    expect(plan.problem).toMatch(/compaction model "beam"/);
    expect(plan.problem).toMatch(/the provider the switch names/);
    expect(plan.problem).toMatch(/NVIDIA/);
  });

  test('the same switch WITHOUT a global compaction model is honoured', () => {
    // The control for the test above: it refuses because of the compaction
    // pair, not because of the main pair.
    recordProviderModels('p1', 'http://p1', ['llama3']);
    recordProviderModels('p2', 'http://p2', ['llama3', 'beam']);

    const plan = planModelSwitch(switchConfig, { ...onCloud, providerId: 'p1' });
    expect(plan.ok).toBe(true);
    expect(plan.target.provider.id).toBe('p1');
  });

  test('a COLD index never refuses a switch', () => {
    // Fail open: an index that cannot say must never break a running turn.
    const plan = planModelSwitch(switchConfig, { ...onCloud, providerId: 'p1' });
    expect(plan.ok).toBe(true);
  });

  test('a switch onto a provider that is not configured is REFUSED', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);

    const plan = planModelSwitch(switchConfig, { ...onCloud, providerId: 'gone' });
    expect(plan.ok).toBe(false);
    expect(plan.problem).toMatch(/"gone" is not configured/);
  });

  test('an explicit compaction selection is checked against its OWN provider', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);
    recordProviderModels('p2', 'http://p2', ['llama3', 'beam']);

    // The main provider (NVIDIA) does NOT serve "beam", but the explicit
    // selection names the provider that does.
    const good = planModelSwitch(switchConfig, {
      ...onCloud,
      providerId: 'p1',
      compaction: { kind: 'explicit', model: 'beam', providerId: 'p2' },
    });
    expect(good.ok).toBe(true);
    expect(good.target.compaction).toStrictEqual({
      kind: 'explicit',
      model: 'beam',
      providerId: 'p2',
    });

    // The same selection on the provider that does NOT serve it is refused.
    const bad = planModelSwitch(switchConfig, {
      ...onCloud,
      providerId: 'p1',
      compaction: { kind: 'explicit', model: 'beam', providerId: 'p1' },
    });
    expect(bad.ok).toBe(false);
    expect(bad.problem).toMatch(/does not serve the model "beam"/);
  });

  test('the switch replaces the compaction selection WHOLE', () => {
    recordProviderModels('p1', 'http://p1', ['llama3']);
    recordProviderModels('p2', 'http://p2', ['llama3', 'beam']);

    // A switch that names a compaction selection uses it...
    const named = planModelSwitch(switchConfig, {
      ...onCloud,
      providerId: 'p1',
      compaction: { kind: 'same-as-main' },
    });
    expect(named.ok).toBe(true);
    expect(named.target.compaction).toStrictEqual({ kind: 'same-as-main' });

    // ...and a switch that names none keeps the one the turn has.
    const unnamed = planModelSwitch(switchConfig, {
      ...onCloud,
      providerId: 'p1',
      currentCompaction: { kind: 'explicit', model: 'beam', providerId: 'p2' },
    });
    expect(unnamed.ok).toBe(true);
    expect(unnamed.target.compaction).toStrictEqual({
      kind: 'explicit',
      model: 'beam',
      providerId: 'p2',
    });
  });
});

describe('a refusal on a stale list heals instead of waiting out the TTL (A12)', () => {
  test('a "not served" answer kicks the background refresh, so the next ask sees the new list', async () => {
    // The list is a few minutes old and the provider has gained the model
    // since. The first ask is refused on the stale list - and it must start
    // the refresh, or the refusal would stand until the whole TTL ran out.
    recordProviderModels('p1', 'http://p1', ['other']);
    setModelIndexDeps({ fetchModels: async () => ['beam', 'other'] });
    // 90 s later: past the refresh throttle (60 s), inside the TTL (5 min).
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 90_000);
    try {
      expect(configProblemFor(config, 'p1', 'beam')).toMatch(/does not serve the model "beam"/);
      await new Promise((resolve) => setImmediate(resolve));
      expect(configProblemFor(config, 'p1', 'beam')).toBeNull();
    } finally {
      nowSpy.mockRestore();
      setModelIndexDeps({ fetchModels: async () => [] });
    }
  });

  test('the same holds for an inherited compaction model with no provider of its own', async () => {
    recordProviderModels('p2', 'http://p2', ['llama3']);
    setModelIndexDeps({ fetchModels: async (p) => (p.id === 'p2' ? ['llama3', 'beam'] : []) });
    // 200 s later, so the sweep the previous test started (a module-level
    // throttle of 60 s) is out of the way, and still inside the 5 min TTL.
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 200_000);
    try {
      const input = {
        mainModel: 'llama3',
        mainProvider: config.providers[1],
        compaction: { kind: 'inherit-default' },
      };
      const withBeam = { ...config, compactionModel: 'beam' };
      expect(compactionProblemFor(withBeam, input)).toMatch(/compaction model "beam"/);
      await new Promise((resolve) => setImmediate(resolve));
      expect(compactionProblemFor(withBeam, input)).toBeNull();
    } finally {
      nowSpy.mockRestore();
      setModelIndexDeps({ fetchModels: async () => [] });
    }
  });
});
