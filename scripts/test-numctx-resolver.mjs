#!/usr/bin/env node
/**
 * Tests for the server-owned context window (src/services/capResolver.ts and
 * src/services/contextWindow/resolveNumCtx.ts).
 *
 * Run with: npx tsx scripts/test-numctx-resolver.mjs
 *
 * No real provider is contacted. Probes are fakes handed to the resolver, time
 * is a fake clock, and the one HTTP check talks to a throwaway local server
 * so the real adapter mapping of a `/v1/models` entry is exercised.
 */

import assert from 'node:assert/strict';
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
import { createFakeClock } from './fakeClock.mjs';

let pass = 0;
let fail = 0;

async function check(label, fn) {
  clearCapCache();
  try {
    await fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message.split('\n').join('\n        ')}`);
    fail += 1;
  }
}

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

// ── the rule ───────────────────────────────────────────────────────────────

console.log('effective = min(setting, model max), or the setting when the max is unknown');

await check('a known maximum below the setting caps it', () => {
  assert.equal(computeEffectiveNumCtx(42_000, 40_960), 40_960);
});

await check('a known maximum above the setting leaves the setting', () => {
  assert.equal(computeEffectiveNumCtx(30_000, 1_000_000), 30_000);
});

await check('an unknown maximum leaves the setting', () => {
  assert.equal(computeEffectiveNumCtx(300_000, null), 300_000);
});

await check('no setting gives no window, whatever the maximum', () => {
  assert.equal(computeEffectiveNumCtx(null, 40_960), null);
  assert.equal(computeEffectiveNumCtx(null, null), null);
});

await check('the provider setting beats the global one; the global one is the fallback', () => {
  assert.equal(pickRequestedNumCtx(276_480, 131_072), 276_480);
  assert.equal(pickRequestedNumCtx(undefined, 131_072), 131_072);
  assert.equal(pickRequestedNumCtx(null, 131_072), 131_072);
  assert.equal(pickRequestedNumCtx(undefined, undefined), null);
});

await check('a setting that is not a positive whole number is ignored', () => {
  assert.equal(pickRequestedNumCtx(0, 131_072), 131_072);
  assert.equal(pickRequestedNumCtx(-5, 131_072), 131_072);
  assert.equal(pickRequestedNumCtx(1.5, undefined), null);
  assert.equal(pickRequestedNumCtx('abc', 131_072), 131_072);
});

await check('the resolution carries setting, maximum, effective, known and source', async () => {
  const { deps } = harness(async () => ollamaInfo(40_960));
  const result = await resolveNumCtx(
    { ctx: OLLAMA, model: 'qwen3:0.6b', providerNumCtx: 42_000, configNumCtx: 999 },
    deps
  );
  assert.deepEqual(result, {
    requested: 42_000,
    modelMax: 40_960,
    effective: 40_960,
    known: true,
    source: 'static',
    probeError: null,
  });
});

// ── Ollama ─────────────────────────────────────────────────────────────────

console.log('Ollama');

await check('the maximum is /api/show context_length', async () => {
  const { deps } = harness(async () => ollamaInfo(1_048_576));
  const result = await resolveModelMax(OLLAMA, 'beam', deps);
  assert.equal(result.modelMax, 1_048_576);
  assert.equal(result.source, 'static');
});

await check('a Modelfile num_ctx is read before the structured context_length', async () => {
  const { deps } = harness(async () => ({
    parameters: 'num_ctx 524288\n',
    model_info: { 'qwen3.context_length': 262_144 },
  }));
  assert.equal(await maxOf(OLLAMA, 'm', deps), 524_288);
});

await check('/api/ps is never a source of the maximum', () => {
  const source = read('src/services/capResolver.ts');
  const code = source.replaceAll(/\/\*[\S\s]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !code.includes('fetchLlmRunningModelContextLength'),
    'the runtime probe is still called'
  );
  assert.ok(!code.includes('/api/ps'), 'the runtime endpoint is still used');
});

// ── llama.cpp ──────────────────────────────────────────────────────────────

console.log('llama.cpp');

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

await check(
  'an unloaded model has no known maximum, even with a trained context_length',
  async () => {
    const { deps } = harness(async () =>
      llamaInfo({
        contextLength: 1_048_576,
        status: { value: 'unloaded', args: ['--jinja'] },
        meta: { n_ctx_train: 1_048_576 },
      })
    );
    const result = await resolveModelMax(OPENAI, 'Muse', deps);
    assert.equal(result.modelMax, null);
    assert.equal(result.source, 'unknown');
  }
);

await check('a loaded model uses meta.n_ctx, not context_length or n_ctx_train', async () => {
  const { deps } = harness(async () =>
    llamaInfo({
      contextLength: 1_048_576,
      status: { value: 'loaded' },
      meta: { n_ctx: 393_216, n_ctx_train: 1_048_576 },
    })
  );
  const result = await resolveModelMax(OPENAI, 'Ornith', deps);
  assert.equal(result.modelMax, 393_216);
  assert.equal(result.source, 'llamacpp-loaded');
});

await check('a loaded model with no meta.n_ctx is unknown, not its trained context', async () => {
  const { deps } = harness(async () =>
    llamaInfo({ contextLength: 262_144, status: { value: 'loaded' }, meta: { n_embd: 2048 } })
  );
  assert.equal(await maxOf(OPENAI, 'm', deps), null);
});

await check('a plain llama-server (no status) with meta.n_ctx is known', async () => {
  const { deps } = harness(async () => llamaInfo({ meta: { n_ctx: 65_536 } }));
  assert.equal(await maxOf(OPENAI, 'm', deps), 65_536);
});

await check(
  'a status that is not "loaded" is unknown even when stale meta is present',
  async () => {
    const { deps } = harness(async () =>
      llamaInfo({ status: { value: 'loading' }, meta: { n_ctx: 262_144 } })
    );
    assert.equal(await maxOf(OPENAI, 'm', deps), null);
  }
);

await check('llama.cpp is recognised from a raw owned_by too', async () => {
  const { deps } = harness(async () => ({
    model_info: { owned_by: 'llamacpp', context_length: 131_072 },
  }));
  assert.equal(await maxOf(OPENAI, 'm', deps), null);
});

// ── the real /v1/models mapping ────────────────────────────────────────────

console.log('the real adapter mapping of a llama.cpp /v1/models list');

await check(
  'loaded gives meta.n_ctx and unloaded gives unknown, through the real adapter',
  async () => {
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
      assert.equal(loaded.modelMax, 262_144);
      assert.equal(loaded.source, 'llamacpp-loaded');
      const unloaded = await resolveModelMax(ctx, 'unloaded-model');
      assert.equal(unloaded.modelMax, null, 'the trained context_length was used');
      const plain = await resolveModelMax(ctx, 'plain-model');
      assert.equal(plain.modelMax, 8192);
      assert.equal(plain.source, 'openai-models');
    } finally {
      server.close();
    }
  }
);

// ── other OpenAI-compatible providers ──────────────────────────────────────

console.log('other OpenAI-compatible providers');

await check('a published context_length is the maximum', async () => {
  const { deps } = harness(async () => ({ model_info: { context_length: 276_480 } }));
  const result = await resolveModelMax(OPENAI, 'router/model', deps);
  assert.equal(result.modelMax, 276_480);
  assert.equal(result.source, 'openai-models');
});

await check('a provider that states no maximum (NVIDIA) is unknown, with no error', async () => {
  const { deps } = harness(async () => ({
    model_info: { displayName: 'nemotron', details: { parent_model: 'nvidia' } },
    details: { parent_model: 'nvidia' },
  }));
  const result = await resolveModelMax(OPENAI, 'nvidia/nemotron', deps);
  assert.deepEqual(result, { modelMax: null, source: 'unknown', probeError: null });
});

await check('the setting is used unchanged when the maximum is unknown', async () => {
  const { deps } = harness(async () => ({ model_info: {} }));
  const result = await resolveNumCtx({ ctx: OPENAI, model: 'm', providerNumCtx: 300_000 }, deps);
  assert.equal(result.effective, 300_000);
  assert.equal(result.known, false);
});

// ── a limit learned from a 400 ─────────────────────────────────────────────

console.log('a limit learned from a 400');

await check('a learned limit applies, and says where it came from', async () => {
  const { deps, calls } = harness(async () => ({ model_info: {} }));
  recordDiscoveredCap(OPENAI, 'nvidia/nemotron', 1_048_576, deps.now());
  const result = await resolveNumCtx(
    { ctx: OPENAI, model: 'nvidia/nemotron', configNumCtx: 2_000_000 },
    deps
  );
  assert.equal(result.modelMax, 1_048_576);
  assert.equal(result.effective, 1_048_576);
  assert.equal(result.source, 'learned');
  assert.equal(calls.length, 0, 'a learned limit should not be probed over');
});

await check('a learned limit lasts 5 minutes, then the model is probed again', async () => {
  const { deps, calls, clock } = harness(async () => ({ model_info: { context_length: 900_000 } }));
  recordDiscoveredCap(OPENAI, 'm', 262_144, deps.now());
  clock.advance(CAP_LEARNED_TTL_MS - 1);
  assert.equal(await maxOf(OPENAI, 'm', deps), 262_144);
  clock.advance(1);
  const after = await resolveModelMax(OPENAI, 'm', deps);
  assert.equal(after.modelMax, 900_000);
  assert.equal(calls.length, 1);
});

await check('a learned limit replaces what an earlier probe found', async () => {
  const { deps } = harness(async () => ollamaInfo(1_048_576));
  assert.equal(await maxOf(OLLAMA, 'm', deps), 1_048_576);
  recordDiscoveredCap(OLLAMA, 'm', 131_072, deps.now());
  const result = await resolveModelMax(OLLAMA, 'm', deps);
  assert.equal(result.modelMax, 131_072);
  assert.equal(result.source, 'learned');
});

await check('a probe that finishes after a 400 taught a limit does not undo it', async () => {
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
  assert.equal(result.modelMax, 131_072);
  assert.equal(await sourceOf(OLLAMA, 'm', deps), 'learned');
});

// ── timeouts and caching ───────────────────────────────────────────────────

console.log('timeouts and caching');

await check('the probe timeout is 10 seconds', () => {
  assert.equal(CAP_PROBE_TIMEOUT_MS, 10_000);
});

await check('a probe that never answers fails after 10 s, with no known maximum', async () => {
  const { deps, clock } = harness(() => new Promise(() => {}));
  let settled = false;
  const pending = resolveModelMax(OLLAMA, 'm', deps).then((value) => {
    settled = true;
    return value;
  });
  clock.advance(CAP_PROBE_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(settled, false, 'gave up before 10 s');
  clock.advance(1);
  const result = await pending;
  assert.equal(result.modelMax, null);
  assert.equal(result.source, 'unknown');
  assert.match(result.probeError, /timed out after 10 s/);
});

await check('a failed probe is remembered for 60 s and does not stall the next turn', async () => {
  const { deps, calls, clock } = harness(async () => {
    throw new Error('connect ECONNREFUSED');
  });
  const first = await resolveModelMax(OLLAMA, 'm', deps);
  assert.equal(first.modelMax, null);
  assert.match(first.probeError, /ECONNREFUSED/);
  assert.equal(calls.length, 1);

  clock.advance(CAP_FAILURE_TTL_MS - 1);
  const second = await resolveModelMax(OLLAMA, 'm', deps);
  assert.equal(calls.length, 1, 'probed again inside 60 s');
  assert.match(second.probeError, /ECONNREFUSED/);

  clock.advance(1);
  await resolveModelMax(OLLAMA, 'm', deps);
  assert.equal(calls.length, 2, 'not probed again after 60 s');
});

await check('a timed-out probe is also remembered for 60 s', async () => {
  const { deps, calls, clock } = harness(() => new Promise(() => {}));
  const pending = resolveModelMax(OLLAMA, 'm', deps);
  clock.advance(CAP_PROBE_TIMEOUT_MS);
  await pending;
  clock.advance(CAP_FAILURE_TTL_MS - 1);
  await resolveModelMax(OLLAMA, 'm', deps);
  assert.equal(calls.length, 1);
});

await check('an answer that arrives after the timeout does not replace the failure', async () => {
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
  assert.equal(again.modelMax, null);
  assert.match(again.probeError, /timed out/);
});

await check('a success is trusted for 5 minutes, then probed again', async () => {
  const { deps, calls, clock } = harness(async () => ollamaInfo(40_960));
  await resolveModelMax(OLLAMA, 'm', deps);
  clock.advance(CAP_SUCCESS_TTL_MS - 1);
  await resolveModelMax(OLLAMA, 'm', deps);
  assert.equal(calls.length, 1, 'probed again inside 5 minutes');
  clock.advance(1);
  await resolveModelMax(OLLAMA, 'm', deps);
  assert.equal(calls.length, 2, 'not probed again after 5 minutes');
});

await check('"answered, but states no maximum" is cached for 5 minutes, not 60 s', async () => {
  const { deps, calls, clock } = harness(async () => ({ model_info: {} }));
  await resolveModelMax(OPENAI, 'nvidia/x', deps);
  clock.advance(CAP_SUCCESS_TTL_MS - 1);
  await resolveModelMax(OPENAI, 'nvidia/x', deps);
  assert.equal(calls.length, 1);
});

await check('callers for one model at the same moment share one probe', async () => {
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
  assert.equal(calls.length, 1);
  assert.equal(a.modelMax, 40_960);
  assert.equal(b.modelMax, 40_960);
});

await check(
  'two models are probed in parallel, so the worst case is one timeout, not two',
  async () => {
    const { deps, calls, clock } = harness(() => new Promise(() => {}));
    const both = Promise.all([
      resolveModelMax(OLLAMA, 'main', deps),
      resolveModelMax(OLLAMA, 'compaction', deps),
    ]);
    assert.equal(calls.length, 2, 'the second probe waited for the first');
    clock.advance(CAP_PROBE_TIMEOUT_MS);
    const [a, b] = await both;
    assert.equal(a.modelMax, null);
    assert.equal(b.modelMax, null);
  }
);

await check(
  'a probe that throws before it returns a promise is a failure, not a crash',
  async () => {
    const { deps } = harness(() => {
      throw new Error('synchronous failure');
    });
    const result = await resolveModelMax(OLLAMA, 'm', deps);
    assert.equal(result.modelMax, null);
    assert.match(result.probeError, /synchronous failure/);
  }
);

// ── cache keys and invalidation ────────────────────────────────────────────

console.log('cache keys and invalidation');

await check('the same model name on two endpoints is two entries', async () => {
  const { deps } = harness(async (ctx) => ollamaInfo(ctx.baseUrl.includes('a.test') ? 1000 : 2000));
  const a = await resolveModelMax({ baseUrl: 'http://a.test', provider: 'ollama' }, 'm', deps);
  const b = await resolveModelMax({ baseUrl: 'http://b.test', provider: 'ollama' }, 'm', deps);
  assert.equal(a.modelMax, 1000);
  assert.equal(b.modelMax, 2000);
});

await check('the same endpoint through two provider kinds is two entries', async () => {
  const { deps, calls } = harness(async () => ({ model_info: { context_length: 8192 } }));
  const baseUrl = 'http://same.test';
  await resolveModelMax({ baseUrl, provider: 'ollama' }, 'm', deps);
  await resolveModelMax({ baseUrl, provider: 'openai-compatible' }, 'm', deps);
  assert.equal(calls.length, 2);
});

await check('a context with no provider is cached as Ollama', async () => {
  const { deps, calls } = harness(async () => ollamaInfo(8192));
  await resolveModelMax({ baseUrl: 'http://x.test' }, 'm', deps);
  await resolveModelMax({ baseUrl: 'http://x.test', provider: 'ollama' }, 'm', deps);
  assert.equal(calls.length, 1);
});

await check('invalidating an endpoint and model clears it for every provider kind', async () => {
  const { deps, calls } = harness(async () => ({ model_info: { context_length: 8192 } }));
  const baseUrl = 'http://same.test';
  await resolveModelMax({ baseUrl, provider: 'ollama' }, 'm', deps);
  await resolveModelMax({ baseUrl, provider: 'openai-compatible' }, 'm', deps);
  await resolveModelMax({ baseUrl, provider: 'ollama' }, 'other', deps);
  invalidateCapCache(baseUrl, 'm');
  await resolveModelMax({ baseUrl, provider: 'ollama' }, 'm', deps);
  await resolveModelMax({ baseUrl, provider: 'openai-compatible' }, 'm', deps);
  await resolveModelMax({ baseUrl, provider: 'ollama' }, 'other', deps);
  assert.equal(calls.length, 5, 'only the two "m" entries should have been probed again');
});

await check(
  'invalidating an endpoint clears every model on it; with no arguments, everything',
  async () => {
    const { deps, calls } = harness(async () => ollamaInfo(8192));
    await resolveModelMax({ baseUrl: 'http://one.test', provider: 'ollama' }, 'a', deps);
    await resolveModelMax({ baseUrl: 'http://one.test', provider: 'ollama' }, 'b', deps);
    await resolveModelMax({ baseUrl: 'http://two.test', provider: 'ollama' }, 'a', deps);
    invalidateCapCache('http://one.test');
    await resolveModelMax({ baseUrl: 'http://one.test', provider: 'ollama' }, 'a', deps);
    await resolveModelMax({ baseUrl: 'http://one.test', provider: 'ollama' }, 'b', deps);
    await resolveModelMax({ baseUrl: 'http://two.test', provider: 'ollama' }, 'a', deps);
    assert.equal(calls.length, 5);
    invalidateCapCache();
    await resolveModelMax({ baseUrl: 'http://two.test', provider: 'ollama' }, 'a', deps);
    assert.equal(calls.length, 6);
  }
);

// ── the routes ─────────────────────────────────────────────────────────────

console.log('the endpoint and the config route');

await check('GET /api/numctx asks the resolver, takes an id and a model, and never a URL', () => {
  const route = read('src/app/api/numctx/route.ts');
  assert.ok(route.includes('resolveNumCtx('), 'the endpoint does not use the resolver');
  assert.ok(route.includes("textParam(url, 'providerId')"), 'no providerId parameter');
  assert.ok(route.includes("textParam(url, 'model')"), 'no model parameter');
  assert.ok(route.includes('config.activeProviderId'), 'no default provider');
  assert.ok(route.includes('config.model'), 'no default model');
  assert.ok(!/searchParams\.get\('(?:baseUrl|url|apiKey)'\)/.test(route), 'reads a URL or key');
});

await check('GET /api/config asks about the SELECTED model, not the provider default', () => {
  const route = read('src/app/api/config/route.ts');
  assert.ok(route.includes('config.model || resolvedProvider?.provider.model'), 'wrong target');
  assert.ok(!route.includes('activeProvider.model,'), 'the provider default is still probed');
});

await check('saving the config does not clear a learned limit because the setting changed', () => {
  const route = read('src/app/api/config/route.ts');
  assert.ok(!route.includes('current.numCtx !== next.numCtx'), 'numCtx still invalidates');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
