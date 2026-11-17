/**
 * How a provider is resolved from the config.
 *
 * The rule under test: an EXPLICIT provider id is resolved BY ID ONLY. A
 * stale id is refused, never recovered by model name — recovering it would
 * send the request to another provider's endpoint WITH that provider's
 * apiKey, which is the silent wrong endpoint this whole rule exists to
 * end.
 *
 * The compaction path has always resolved its provider by id only. These
 * checks pin that the MAIN path now behaves the same way, so a stale id
 * means one thing everywhere: this conversation cannot run as it is.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { readFile } from 'node:fs/promises';

import {
  configProblemFor,
  MODEL_NOT_CHOSEN_MESSAGE,
  providerNotConfiguredMessage,
  requestProblemFor,
} from '../src/services/contextWindow/configProblem.ts';
import {
  invalidateModelIndex,
  recordProviderModels,
  setModelIndexDeps,
} from '../src/services/modelIndex.ts';
import { resolveProvider } from '../src/services/providerResolver.ts';

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

const chatRoute = await read('../src/app/api/chat/route.ts');
const compactRoute = await read('../src/app/api/compact/route.ts');
const titleRoute = await read('../src/app/api/title/route.ts');

// The background model-index refresh must never reach for a provider during
// a test: it is fire-and-forget, so a real request would outlive the test.
beforeAll(() => {
  setModelIndexDeps({ fetchModels: async () => [] });
});

afterAll(() => {
  setModelIndexDeps(null);
});

// Each test starts with a COLD index: an index that cannot answer must
// never refuse, and a warm one from a previous test would answer.
beforeEach(() => {
  invalidateModelIndex();
});

const provider = (extra = {}) => ({
  id: 'p1',
  name: 'P',
  provider: 'ollama',
  baseUrl: 'http://p1',
  model: 'beam',
  ...extra,
});

/**
 * Two providers whose default models DIFFER, so a model-name recovery is
 * observable: `beam` belongs to `p1`, and the stale id must not land there.
 */
const config = {
  numCtx: 131_072,
  providers: [
    provider({ id: 'p1', name: 'P', model: 'beam', baseUrl: 'http://p1' }),
    provider({ id: 'p2', name: 'Q', model: 'other', baseUrl: 'http://p2' }),
  ],
};

describe('an explicit provider id is resolved by id ONLY', () => {
  test('the id that exists wins, even when another provider owns the model name', () => {
    expect(resolveProvider(config, 'p2', 'beam')?.id).toBe('p2');
  });

  test('a stale id is refused, not recovered by model name', () => {
    // The old behaviour recovered `p1` here — the provider whose DEFAULT
    // model is "beam" — and would have sent this request to p1's baseUrl
    // with p1's apiKey.
    expect(resolveProvider(config, 'gone', 'beam')).toBeNull();
  });

  test('without an id the model name still finds a provider', () => {
    // The model name is the only way to find a provider when the request
    // carries no id, so it stays available for exactly that case.
    expect(resolveProvider(config, undefined, 'beam')?.id).toBe('p1');
  });

  test('without an id and without a model match the first provider is the default', () => {
    expect(resolveProvider(config, undefined, 'nothing-serves-this')?.id).toBe('p1');
  });

  test('no providers at all resolves to nothing', () => {
    expect(resolveProvider({ providers: [] }, 'p1', 'beam')).toBeNull();
  });
});

describe('the refusal names the provider that is missing', () => {
  test('a stale id is refused with a message that names it', () => {
    const problem = configProblemFor(config, 'gone', 'beam');
    expect(problem).toBe(providerNotConfiguredMessage('gone'));
    expect(problem).toMatch(/"gone" is not configured/);
  });

  test('the stale-id refusal is NOT the "no model is set up yet" message', () => {
    // The two problems need different fixes: one needs a model picked, the
    // other needs the provider renamed or removed from config.json.
    expect(configProblemFor(config, 'gone', 'beam')).not.toBe(MODEL_NOT_CHOSEN_MESSAGE);
  });

  test('without an id there is nothing to name, so the setup message stands', () => {
    expect(configProblemFor(config, undefined, 'beam')).toBeNull();
    expect(configProblemFor({ numCtx: 1 }, undefined, 'beam')).toBe(MODEL_NOT_CHOSEN_MESSAGE);
  });

  test('a route that reads an untyped body refuses the same way', () => {
    expect(requestProblemFor(config, { providerId: 'gone', model: 'beam' })).toBe(
      providerNotConfiguredMessage('gone')
    );
    // A blank id means "no id" — the same rule the routes apply.
    expect(requestProblemFor(config, { providerId: '   ', model: 'beam' })).toBeNull();
  });

  test('a provider that exists and has a window runs', () => {
    expect(configProblemFor(config, 'p1', 'beam')).toBeNull();
  });
});

describe('the routes read the same id the gate read', () => {
  test.each([
    ['chat', chatRoute],
    ['compact', compactRoute],
    ['title', titleRoute],
  ])('the %s route normalises a blank provider id to "no id"', (_name, source) => {
    // A whitespace-only id must not be truthy in one place and absent in
    // the other: the gate and the call have to read the same id.
    expect(source).toMatch(/body\.providerId === 'string' && body\.providerId\.trim\(\)/);
  });

  // The chat route's refusal of a provider it cannot resolve, and the mid-turn
  // switch's refusal (announced, and applied to nothing), are driven END TO END
  // in `chat-route-pair-gates.test.mjs`. They used to be pinned here by reading
  // the route's source, which passes even when the gate is deleted.
});

describe('the compaction check runs against the provider the request runs on', () => {
  // The global compaction model with NO global compaction provider runs on
  // the provider the CHAT runs on, and that provider has to serve it
  // (CONFIRMATIONS C-025: `beam` went to NVIDIA and 404ed 221 times).
  const globalConfig = {
    ...config,
    compactionModel: 'beam',
    compactionProviderId: null,
  };

  test('an inherited global compaction model the provider does not serve is REFUSED', () => {
    // `p2` is the provider the request runs on, and it serves `other`, not
    // the global compaction model `beam`.
    recordProviderModels('p1', 'http://p1', ['beam']);
    recordProviderModels('p2', 'http://p2', ['other']);

    const problem = requestProblemFor(globalConfig, {
      providerId: 'p2',
      model: 'other',
      compaction: { kind: 'inherit-default' },
    });
    expect(problem).toMatch(/does not serve it/);
    expect(problem).toMatch(/beam/);
    // the message names the provider that DOES serve it
    expect(problem).toMatch(/P/);
  });

  test('the same request on a provider that DOES serve the compaction model runs', () => {
    recordProviderModels('p2', 'http://p2', ['other', 'beam']);

    expect(
      requestProblemFor(globalConfig, {
        providerId: 'p2',
        model: 'other',
        compaction: { kind: 'inherit-default' },
      })
    ).toBeNull();
  });

  test('the chat route hands the compaction check the RESOLVED provider', () => {
    // The resolved provider, not the raw id and never `providers[0]`: a
    // provider with no default model would otherwise be checked against
    // the wrong endpoint, and a working turn refused. The id must be IN
    // there - `resolveProvider(config, undefined, model)` would drop it and
    // land on `providers[0]`, which is the trap. The behavioural half of
    // this is pinned in `tests/model-index.test.mjs`.
    expect(chatRoute).toMatch(/mainProvider: resolveProvider\([^)]*providerId/);
  });
});
