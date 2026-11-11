/**
 * Tests for the server-owned context window (src/services/capResolver.ts and
 * src/services/contextWindow/resolveNumCtx.ts).
 *
 * No real provider is contacted. Probes are fakes handed to the resolver, time
 * is a fake clock, and the one HTTP check talks to a throwaway local server
 * so the real adapter mapping of a `/v1/models` entry is exercised.
 */

import { beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAP_FAILURE_TTL_MS,
  CAP_LEARNED_TTL_MS,
  CAP_PROBE_TIMEOUT_MS,
  CAP_SUCCESS_TTL_MS,
  clearCapCache,
  invalidateCapCache,
  recordDiscoveredCap,
  resolveModelMax,
} from '../src/services/capResolver.ts';
import {
  computeEffectiveNumCtx,
  pickRequestedNumCtx,
  resolveNumCtx,
} from '../src/services/contextWindow/resolveNumCtx.ts';
import { createFakeClock } from './helpers/fakeClock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, '..', relative), 'utf8');

/** The maximum a probe found, read off the resolution. */
async function maxOf(ctx, model, deps) {
  const result = await resolveModelMax(ctx, model, deps);
  return result.modelMax;
}

/** Where the maximum came from, read off the resolution. */
async function sourceOf(ctx, model, deps) {
  const result = await resolveModelMax(ctx, model, deps);
  return result.source;
}

// Every test starts with an empty cap cache.
beforeEach(() => {
  clearCapCache();
});

const OLLAMA = { baseUrl: 'http://ollama.test', provider: 'ollama' };
const OPENAI = { baseUrl: 'http://openai.test', provider: 'openai-compatible' };

/** Deps with a fake clock and a probe that answers from `respond`. */
function harness(respond) {
  const clock = createFakeClock();
  const calls = [];
  const deps = {
    now: () => clock.now(),
    setTimer: (callback, ms) => clock.schedule(callback, ms),
    clearTimer: (handle) => clock.cancel(handle),
    fetchModelInfo: (ctx, model) => {
      calls.push({ ctx, model });
      return respond(ctx, model);
    },
  };
  return { clock, calls, deps };
}

const ollamaInfo = (contextLength) => ({
  model_info: { 'qwen3.context_length': contextLength },
});

describe('effective = min(setting, model max), or the setting when the max is unknown', () => {
  test('a known maximum below the setting caps it', () => {
    expect(computeEffectiveNumCtx(42_000, 40_960)).toBe(40_960);
  });

  test('a known maximum above the setting leaves the setting', () => {
    expect(computeEffectiveNumCtx(30_000, 1_000_000)).toBe(30_000);
  });

  test('an unknown maximum leaves the setting', () => {
    expect(computeEffectiveNumCtx(300_000, null)).toBe(300_000);
  });

  test('no setting gives no window, whatever the maximum', () => {
    expect(computeEffectiveNumCtx(null, 40_960)).toBeNull();
    expect(computeEffectiveNumCtx(null, null)).toBeNull();
  });

  test('the provider setting beats the global one; the global one is the fallback', () => {
    expect(pickRequestedNumCtx(276_480, 131_072)).toBe(276_480);
    expect(pickRequestedNumCtx(undefined, 131_072)).toBe(131_072);
    expect(pickRequestedNumCtx(null, 131_072)).toBe(131_072);
    expect(pickRequestedNumCtx(undefined, undefined)).toBeNull();
  });

  test('a setting that is not a positive whole number is ignored', () => {
    expect(pickRequestedNumCtx(0, 131_072)).toBe(131_072);
    expect(pickRequestedNumCtx(-5, 131_072)).toBe(131_072);
    expect(pickRequestedNumCtx(1.5, undefined)).toBeNull();
    expect(pickRequestedNumCtx('abc', 131_072)).toBe(131_072);
  });

  test('the resolution carries setting, maximum, effective, known and source', async () => {
    const { deps } = harness(async () => ollamaInfo(40_960));
    const result = await resolveNumCtx(
      { ctx: OLLAMA, model: 'qwen3:0.6b', providerNumCtx: 42_000, configNumCtx: 999 },
      deps
    );
    expect(result).toStrictEqual({
      requested: 42_000,
      modelMax: 40_960,
      effective: 40_960,
      known: true,
      source: 'static',
      probeError: null,
    });
  });
});

describe('Ollama', () => {
  test('the maximum is /api/show context_length', async () => {
    const { deps } = harness(async () => ollamaInfo(1_048_576));
    const result = await resolveModelMax(OLLAMA, 'beam', deps);
    expect(result.modelMax).toBe(1_048_576);
    expect(result.source).toBe('static');
  });

  test('a Modelfile num_ctx is read before the structured context_length', async () => {
    const { deps } = harness(async () => ({
      parameters: 'num_ctx 524288\n',
      model_info: { 'qwen3.context_length': 262_144 },
    }));
    expect(await maxOf(OLLAMA, 'm', deps)).toBe(524_288);
  });

  test('/api/ps is never a source of the maximum', () => {
    const source = read('src/services/capResolver.ts');
    const code = source.replaceAll(/\/\*[\S\s]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('fetchLlmRunningModelContextLength');
    expect(code).not.toContain('/api/ps');
  });
});

describe('llama.cpp', () => {
  // A llama.cpp entry as `fetchOpenAICompatibleModelInfo` hands it over: the
  // entry's `owned_by` has moved to `details.parent_model`, and `meta`, `status`
  // and `context_length` are in `model_info`.
  const llamaInfo = ({ status, meta, contextLength }) => ({
    model_info: {
      ...(contextLength === undefined ? {} : { context_length: contextLength }),
      ...(meta === undefined ? {} : { meta }),
      ...(status === undefined ? {} : { status }),
    },
    details: { parent_model: 'llamacpp' },
  });

  test('an unloaded model has no known maximum, even with a trained context_length', async () => {
    const { deps } = harness(async () =>
      llamaInfo({
        contextLength: 1_048_576,
        status: { value: 'unloaded', args: ['--jinja'] },
        meta: { n_ctx_train: 1_048_576 },
      })
    );
    const result = await resolveModelMax(OPENAI, 'Muse', deps);
    expect(result.modelMax).toBeNull();
    expect(result.source).toBe('unknown');
  });

  test('a loaded model uses meta.n_ctx, not context_length or n_ctx_train', async () => {
    const { deps } = harness(async () =>
      llamaInfo({
        contextLength: 1_048_576,
        status: { value: 'loaded' },
        meta: { n_ctx: 393_216, n_ctx_train: 1_048_576 },
      })
    );
    const result = await resolveModelMax(OPENAI, 'Ornith', deps);
    expect(result.modelMax).toBe(393_216);
    expect(result.source).toBe('llamacpp-loaded');
  });

  test('a loaded model with no meta.n_ctx is unknown, not its trained context', async () => {
    const { deps } = harness(async () =>
      llamaInfo({ contextLength: 262_144, status: { value: 'loaded' }, meta: { n_embd: 2048 } })
    );
    expect(await maxOf(OPENAI, 'm', deps)).toBeNull();
  });

  test('a plain llama-server (no status) with meta.n_ctx is known', async () => {
    const { deps } = harness(async () => llamaInfo({ meta: { n_ctx: 65_536 } }));
    expect(await maxOf(OPENAI, 'm', deps)).toBe(65_536);
  });

  test('a status that is not "loaded" is unknown even when stale meta is present', async () => {
    const { deps } = harness(async () =>
      llamaInfo({ status: { value: 'loading' }, meta: { n_ctx: 262_144 } })
    );
    expect(await maxOf(OPENAI, 'm', deps)).toBeNull();
  });

  test('llama.cpp is recognised from a raw owned_by too', async () => {
    const { deps } = harness(async () => ({
      model_info: { owned_by: 'llamacpp', context_length: 131_072 },
    }));
    expect(await maxOf(OPENAI, 'm', deps)).toBeNull();
  });
});

describe('the real adapter mapping of a llama.cpp /v1/models list', () => {
  test('loaded gives meta.n_ctx and unloaded gives unknown, through the real adapter', async () => {
    const entries = [
      {
        id: 'loaded-model',
        object: 'model',
        created: 1,
        owned_by: 'llamacpp',
        context_length: 1_048_576,
        meta: { n_ctx: 262_144, n_ctx_train: 1_048_576 },
        status: { value: 'loaded', args: [] },
      },
      {
        id: 'unloaded-model',
        object: 'model',
        created: 1,
        owned_by: 'llamacpp',
        context_length: 1_048_576,
        status: { value: 'unloaded', args: ['--jinja'] },
      },
      { id: 'plain-model', object: 'model', created: 1, owned_by: 'someone', context_length: 8192 },
    ];
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: entries }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const ctx = {
        provider: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      };
      const loaded = await resolveModelMax(ctx, 'loaded-model');
      expect(loaded.modelMax).toBe(262_144);
      expect(loaded.source).toBe('llamacpp-loaded');
      const unloaded = await resolveModelMax(ctx, 'unloaded-model');
      expect(unloaded.modelMax).toBeNull();
      const plain = await resolveModelMax(ctx, 'plain-model');
      expect(plain.modelMax).toBe(8192);
      expect(plain.source).toBe('openai-models');
    } finally {
      server.close();
    }
  });
});

describe('other OpenAI-compatible providers', () => {
  test('a published context_length is the maximum', async () => {
    const { deps } = harness(async () => ({ model_info: { context_length: 276_480 } }));
    const result = await resolveModelMax(OPENAI, 'router/model', deps);
    expect(result.modelMax).toBe(276_480);
    expect(result.source).toBe('openai-models');
  });

  test('a provider that states no maximum (NVIDIA) is unknown, with no error', async () => {
    const { deps } = harness(async () => ({
      model_info: { displayName: 'nemotron', details: { parent_model: 'nvidia' } },
      details: { parent_model: 'nvidia' },
    }));
    const result = await resolveModelMax(OPENAI, 'nvidia/nemotron', deps);
    expect(result).toStrictEqual({ modelMax: null, source: 'unknown', probeError: null });
  });

  test('the setting is used unchanged when the maximum is unknown', async () => {
    const { deps } = harness(async () => ({ model_info: {} }));
    const result = await resolveNumCtx({ ctx: OPENAI, model: 'm', providerNumCtx: 300_000 }, deps);
    expect(result.effective).toBe(300_000);
    expect(result.known).toBe(false);
  });
});

describe('a limit learned from a 400', () => {
  test('a learned limit applies, and says where it came from', async () => {
    const { deps, calls } = harness(async () => ({ model_info: {} }));
    recordDiscoveredCap(OPENAI, 'nvidia/nemotron', 1_048_576, deps.now());
    const result = await resolveNumCtx(
      { ctx: OPENAI, model: 'nvidia/nemotron', configNumCtx: 2_000_000 },
      deps
    );
    expect(result.modelMax).toBe(1_048_576);
    expect(result.effective).toBe(1_048_576);
    expect(result.source).toBe('learned');
    expect(calls).toHaveLength(0);
  });

  test('a learned limit lasts 5 minutes, then the model is probed again', async () => {
    const { deps, calls, clock } = harness(async () => ({
      model_info: { context_length: 900_000 },
    }));
    recordDiscoveredCap(OPENAI, 'm', 262_144, deps.now());
    clock.advance(CAP_LEARNED_TTL_MS - 1);
    expect(await maxOf(OPENAI, 'm', deps)).toBe(262_144);
    clock.advance(1);
    const after = await resolveModelMax(OPENAI, 'm', deps);
    expect(after.modelMax).toBe(900_000);
    expect(calls).toHaveLength(1);
  });

  test('a learned limit replaces what an earlier probe found', async () => {
    const { deps } = harness(async () => ollamaInfo(1_048_576));
    expect(await maxOf(OLLAMA, 'm', deps)).toBe(1_048_576);
    recordDiscoveredCap(OLLAMA, 'm', 131_072, deps.now());
    const result = await resolveModelMax(OLLAMA, 'm', deps);
    expect(result.modelMax).toBe(131_072);
    expect(result.source).toBe('learned');
  });

  test('a probe that finishes after a 400 taught a limit does not undo it', async () => {
    let release;
    const { deps } = harness(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ollamaInfo(1_048_576));
        })
    );
    const pending = resolveModelMax(OLLAMA, 'm', deps);
    recordDiscoveredCap(OLLAMA, 'm', 131_072, deps.now());
    release();
    const result = await pending;
    expect(result.modelMax).toBe(131_072);
    expect(await sourceOf(OLLAMA, 'm', deps)).toBe('learned');
  });
});

describe('timeouts and caching', () => {
  test('the probe timeout is 10 seconds', () => {
    expect(CAP_PROBE_TIMEOUT_MS).toBe(10_000);
  });

  test('a probe that never answers fails after 10 s, with no known maximum', async () => {
    const { deps, clock } = harness(() => new Promise(() => {}));
    let settled = false;
    const pending = resolveModelMax(OLLAMA, 'm', deps).then((value) => {
      settled = true;
      return value;
    });
    clock.advance(CAP_PROBE_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    const result = await pending;
    expect(result.modelMax).toBeNull();
    expect(result.source).toBe('unknown');
    expect(result.probeError).toMatch(/timed out after 10 s/);
  });

  test('a failed probe is remembered for 60 s and does not stall the next turn', async () => {
    const { deps, calls, clock } = harness(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const first = await resolveModelMax(OLLAMA, 'm', deps);
    expect(first.modelMax).toBeNull();
    expect(first.probeError).toMatch(/ECONNREFUSED/);
    expect(calls).toHaveLength(1);

    clock.advance(CAP_FAILURE_TTL_MS - 1);
    const second = await resolveModelMax(OLLAMA, 'm', deps);
    expect(calls).toHaveLength(1);
    expect(second.probeError).toMatch(/ECONNREFUSED/);

    clock.advance(1);
    await resolveModelMax(OLLAMA, 'm', deps);
    expect(calls).toHaveLength(2);
  });

  test('a timed-out probe is also remembered for 60 s', async () => {
    const { deps, calls, clock } = harness(() => new Promise(() => {}));
    const pending = resolveModelMax(OLLAMA, 'm', deps);
    clock.advance(CAP_PROBE_TIMEOUT_MS);
    await pending;
    clock.advance(CAP_FAILURE_TTL_MS - 1);
    await resolveModelMax(OLLAMA, 'm', deps);
    expect(calls).toHaveLength(1);
  });

  test('an answer that arrives after the timeout does not replace the failure', async () => {
    let release;
    const { deps, clock } = harness(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ollamaInfo(40_960));
        })
    );
    const pending = resolveModelMax(OLLAMA, 'm', deps);
    clock.advance(CAP_PROBE_TIMEOUT_MS);
    await pending;
    release();
    await Promise.resolve();
    const again = await resolveModelMax(OLLAMA, 'm', deps);
    expect(again.modelMax).toBeNull();
    expect(again.probeError).toMatch(/timed out/);
  });

  test('a success is trusted for 5 minutes, then probed again', async () => {
    const { deps, calls, clock } = harness(async () => ollamaInfo(40_960));
    await resolveModelMax(OLLAMA, 'm', deps);
    clock.advance(CAP_SUCCESS_TTL_MS - 1);
    await resolveModelMax(OLLAMA, 'm', deps);
    expect(calls).toHaveLength(1);
    clock.advance(1);
    await resolveModelMax(OLLAMA, 'm', deps);
    expect(calls).toHaveLength(2);
  });

  test('"answered, but states no maximum" is cached for 5 minutes, not 60 s', async () => {
    const { deps, calls, clock } = harness(async () => ({ model_info: {} }));
    await resolveModelMax(OPENAI, 'nvidia/x', deps);
    clock.advance(CAP_SUCCESS_TTL_MS - 1);
    await resolveModelMax(OPENAI, 'nvidia/x', deps);
    expect(calls).toHaveLength(1);
  });

  test('callers for one model at the same moment share one probe', async () => {
    let release;
    const { deps, calls } = harness(
      () =>
        new Promise((resolve) => {
          release = () => resolve(ollamaInfo(40_960));
        })
    );
    const first = resolveModelMax(OLLAMA, 'm', deps);
    const second = resolveModelMax(OLLAMA, 'm', deps);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(a.modelMax).toBe(40_960);
    expect(b.modelMax).toBe(40_960);
  });

  test('two models are probed in parallel, so the worst case is one timeout, not two', async () => {
    const { deps, calls, clock } = harness(() => new Promise(() => {}));
    const both = Promise.all([
      resolveModelMax(OLLAMA, 'main', deps),
      resolveModelMax(OLLAMA, 'compaction', deps),
    ]);
    expect(calls).toHaveLength(2);
    clock.advance(CAP_PROBE_TIMEOUT_MS);
    const [a, b] = await both;
    expect(a.modelMax).toBeNull();
    expect(b.modelMax).toBeNull();
  });

  test('a probe that throws before it returns a promise is a failure, not a crash', async () => {
    const { deps } = harness(() => {
      throw new Error('synchronous failure');
    });
    const result = await resolveModelMax(OLLAMA, 'm', deps);
    expect(result.modelMax).toBeNull();
    expect(result.probeError).toMatch(/synchronous failure/);
  });
});

describe('cache keys and invalidation', () => {
  test('the same model name on two endpoints is two entries', async () => {
    const { deps } = harness(async (ctx) =>
      ollamaInfo(ctx.baseUrl.includes('a.test') ? 1000 : 2000)
    );
    const a = await resolveModelMax({ baseUrl: 'http://a.test', provider: 'ollama' }, 'm', deps);
    const b = await resolveModelMax({ baseUrl: 'http://b.test', provider: 'ollama' }, 'm', deps);
    expect(a.modelMax).toBe(1000);
    expect(b.modelMax).toBe(2000);
  });

  test('the same endpoint through two provider kinds is two entries', async () => {
    const { deps, calls } = harness(async () => ({ model_info: { context_length: 8192 } }));
    const baseUrl = 'http://same.test';
    await resolveModelMax({ baseUrl, provider: 'ollama' }, 'm', deps);
    await resolveModelMax({ baseUrl, provider: 'openai-compatible' }, 'm', deps);
    expect(calls).toHaveLength(2);
  });

  test('a context with no provider is cached as Ollama', async () => {
    const { deps, calls } = harness(async () => ollamaInfo(8192));
    await resolveModelMax({ baseUrl: 'http://x.test' }, 'm', deps);
    await resolveModelMax({ baseUrl: 'http://x.test', provider: 'ollama' }, 'm', deps);
    expect(calls).toHaveLength(1);
  });

  test('invalidating an endpoint and model clears it for every provider kind', async () => {
    const { deps, calls } = harness(async () => ({ model_info: { context_length: 8192 } }));
    const baseUrl = 'http://same.test';
    await resolveModelMax({ baseUrl, provider: 'ollama' }, 'm', deps);
    await resolveModelMax({ baseUrl, provider: 'openai-compatible' }, 'm', deps);
    await resolveModelMax({ baseUrl, provider: 'ollama' }, 'other', deps);
    invalidateCapCache(baseUrl, 'm');
    await resolveModelMax({ baseUrl, provider: 'ollama' }, 'm', deps);
    await resolveModelMax({ baseUrl, provider: 'openai-compatible' }, 'm', deps);
    await resolveModelMax({ baseUrl, provider: 'ollama' }, 'other', deps);
    expect(calls).toHaveLength(5);
  });

  test('invalidating an endpoint clears every model on it; with no arguments, everything', async () => {
    const { deps, calls } = harness(async () => ollamaInfo(8192));
    await resolveModelMax({ baseUrl: 'http://one.test', provider: 'ollama' }, 'a', deps);
    await resolveModelMax({ baseUrl: 'http://one.test', provider: 'ollama' }, 'b', deps);
    await resolveModelMax({ baseUrl: 'http://two.test', provider: 'ollama' }, 'a', deps);
    invalidateCapCache('http://one.test');
    await resolveModelMax({ baseUrl: 'http://one.test', provider: 'ollama' }, 'a', deps);
    await resolveModelMax({ baseUrl: 'http://one.test', provider: 'ollama' }, 'b', deps);
    await resolveModelMax({ baseUrl: 'http://two.test', provider: 'ollama' }, 'a', deps);
    expect(calls).toHaveLength(5);
    invalidateCapCache();
    await resolveModelMax({ baseUrl: 'http://two.test', provider: 'ollama' }, 'a', deps);
    expect(calls).toHaveLength(6);
  });
});

describe('the endpoint and the config route', () => {
  test('GET /api/numctx asks the resolver, takes an id and a model, and never a URL', () => {
    const route = read('src/app/api/numctx/route.ts');
    expect(route).toContain('resolveNumCtx(');
    expect(route).toContain("textParam(url, 'providerId')");
    expect(route).toContain("textParam(url, 'model')");
    expect(route).toContain('config.activeProviderId');
    expect(route).toContain('config.model');
    expect(route).not.toMatch(/searchParams\.get\('(?:baseUrl|url|apiKey)'\)/);
  });

  test('GET /api/config probes no provider (the page reads the window from /api/numctx)', () => {
    const route = read('src/app/api/config/route.ts');
    expect(route).not.toContain('resolveNumCtx');
    expect(route).not.toContain('modelContextLimit');
    expect(route).not.toContain('activeProvider.model,');
  });

  test('saving the config does not clear a learned limit because the setting changed', () => {
    const route = read('src/app/api/config/route.ts');
    expect(route).not.toContain('current.numCtx !== next.numCtx');
  });
});

describe('the server owns the window: no request body value is used', () => {
  const SERVER_ROUTES = [
    'src/app/api/chat/route.ts',
    'src/app/api/compact/route.ts',
    'src/app/api/title/route.ts',
    'src/app/api/dump/route.ts',
  ];

  for (const file of SERVER_ROUTES) {
    test(`${file} does not read numCtx from the request body`, () => {
      const source = read(file);
      expect(source).not.toMatch(/body\.numCtx/);
      expect(source).not.toMatch(/\bconst numCtx\b/);
      expect(source).not.toContain('bodyRequested');
      expect(source).toContain('resolveNumCtx(');
    });
  }

  test('the chat route resolves a mid-turn switch from the saved config, and keeps both hooks', () => {
    const route = read('src/app/api/chat/route.ts');
    expect(route).toMatch(/fromSavedSetting \? await loadConfig\(\)/);
    expect(route).toContain('resolveNumCtxForModel(true)');
    expect(route).toContain('refreshModels');
  });

  test('the compaction window is resolved against the compaction model, in parallel with the main one', () => {
    const route = read('src/app/api/chat/route.ts');
    expect(route).toMatch(/compactionNumCtx = resolution\.effective/);
    expect(route).toMatch(
      /await Promise\.all\(\[\s*resolveNumCtxForModel\(\),\s*resolveCompactionRuntime\(/
    );
  });

  test('no server code takes a window from a provider default or /api/ps', () => {
    for (const file of [
      ...SERVER_ROUTES,
      'src/app/api/config/route.ts',
      'src/app/api/numctx/route.ts',
    ]) {
      const source = read(file);
      expect(source).not.toContain('resolveEffectiveNumCtx');
      expect(source).not.toContain('getProviderNumCtx');
      expect(source).not.toContain('fetchLlmRunningModelContextLength');
    }
  });

  test('a probe failure is logged, not silent', () => {
    const route = read('src/app/api/chat/route.ts');
    expect(route).toContain("phase: 'numctx_probe_failed'");
    expect(read('src/app/lib/debugLogger.ts')).toContain("'numctx_probe_failed'");
  });
});
