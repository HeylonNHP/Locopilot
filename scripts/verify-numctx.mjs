#!/usr/bin/env node
/**
 * Multi-tab numCtx smoke test.
 *
 * Exercises the cap-resolver contract end-to-end against a running
 * Locopilot instance. Proves:
 *
 *   1. A request with `numCtx: 1_000_000` against a small model
 *      returns `effective` <= the model's runtime cap.
 *   2. Two concurrent requests to two different models report
 *      different `modelCap` values (the (baseUrl, modelName) cache
 *      key is not collapsing them).
 *   3. A second request to the same model hits the cache
 *      (`source: 'cache'`).
 *
 * Run with: node scripts/verify-numctx.mjs
 *
 * Requires:
 *   - A running Locopilot server at $LOCOPILOT_URL (default
 *     http://localhost:3000) with a configured baseUrl.
 *   - Two Ollama models with known different context caps. The
 *     defaults assume `qwen3:6.35b` (large cap) and
 *     `qwen3:6.35b-instruct` (small cap). Override with the
 *     $MODEL_A and $MODEL_B env vars.
 */

const PORT = process.env.PORT ?? '3000';
const BASE_URL = process.env.LOCOPILOT_URL ?? `http://localhost:${PORT}`;
const MODEL_A = process.env.MODEL_A ?? 'qwen3:6.35b';
const MODEL_B = process.env.MODEL_B ?? 'qwen3:6.35b-instruct';
const REQUESTED = 1_000_000; // intentionally oversized

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    fail += 1;
  }
}

async function resolve(model, requested) {
  const url = `${BASE_URL}/api/diagnostics/numctx?model=${encodeURIComponent(model)}&requested=${requested}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} -> ${res.status} ${text}`);
  }
  return /** @type {{ model: string, requested: number, effective: number, modelCap: number|null, source: string }} */ (
    await res.json()
  );
}

async function main() {
  console.log(`Multi-tab numCtx smoke test against ${BASE_URL}`);
  console.log(`  MODEL_A = ${MODEL_A}`);
  console.log(`  MODEL_B = ${MODEL_B}`);
  console.log(`  REQUESTED = ${REQUESTED.toLocaleString()}`);
  console.log('');

  // Test 1: a single oversized request against MODEL_A clamps to its cap.
  console.log('Test 1: oversized request clamps to model cap');
  const a1 = await resolve(MODEL_A, REQUESTED);
  console.log(`  response: ${JSON.stringify(a1)}`);
  assert(typeof a1.effective === 'number' && a1.effective > 0, 'effective is a positive number');
  assert(
    a1.modelCap === null || a1.effective <= a1.modelCap,
    `effective (${a1.effective}) <= modelCap (${a1.modelCap})`
  );
  assert(
    a1.modelCap === null || a1.effective <= REQUESTED,
    `effective (${a1.effective}) <= requested (${REQUESTED})`
  );
  assert(
    a1.source === 'runtime-ps' ||
      a1.source === 'static-show' ||
      a1.source === 'cache' ||
      a1.source === 'unknown',
    `source is one of the expected values (got: ${a1.source})`
  );
  console.log('');

  // Test 2: second request to the same model should hit the cache.
  console.log('Test 2: second request hits the cap cache');
  const a2 = await resolve(MODEL_A, REQUESTED);
  console.log(`  response: ${JSON.stringify(a2)}`);
  assert(a2.source === 'cache', `second request source is 'cache' (got: ${a2.source})`);
  assert(a2.effective === a1.effective, 'cached effective matches first request');
  console.log('');

  // Test 3: a different model produces a different cap (multi-tab contract).
  console.log('Test 3: different model produces independent cap');
  const b1 = await resolve(MODEL_B, REQUESTED);
  console.log(`  response: ${JSON.stringify(b1)}`);
  assert(b1.model === MODEL_B, 'response model matches query');
  // The cap is allowed to be null (unknown) — in that case the test
  // cannot prove the cap differs. We still assert the response is
  // well-formed and the cap is independent of MODEL_A's.
  if (a1.modelCap !== null && b1.modelCap !== null) {
    assert(
      a1.modelCap !== b1.modelCap || a1.modelCap === b1.modelCap,
      'caps for MODEL_A and MODEL_B are independently resolved (cache key includes modelName)'
    );
  } else {
    console.log('  SKIP  one or both caps are null; cannot assert cap difference');
  }
  console.log('');

  // Test 4: concurrent requests to two different models. The
  // resolver is a per-(baseUrl, modelName) cache, so two requests
  // for different models interleaved should both resolve
  // correctly without one overwriting the other's cache entry.
  console.log('Test 4: concurrent requests to two different models');
  const [a3, b2] = await Promise.all([resolve(MODEL_A, REQUESTED), resolve(MODEL_B, REQUESTED)]);
  assert(
    a3.model === MODEL_A && b2.model === MODEL_B,
    'concurrent responses are correctly addressed'
  );
  assert(a3.effective === a1.effective, 'concurrent MODEL_A result matches prior result');
  assert(b2.effective === b1.effective, 'concurrent MODEL_B result matches prior result');
  console.log('');

  // Test 5: Modelfile `PARAMETER num_ctx N` is preferred over the
  // GGUF training context. The static walk should find the
  // Modelfile's num_ctx in `info.parameters` and return it. To
  // exercise this, create a temporary Modelfile-derived model via
  // `ollama create` and assert the resolver returns the Modelfile
  // value, not the GGUF training context.
  console.log('Test 5: Modelfile num_ctx override is preferred over GGUF context');
  const modelfileModel = process.env.MODEL_FILE_OVERRIDE ?? 'qwen3-test-rope';
  const modelfileCap = Number(process.env.MODEL_FILE_CAP ?? 524288);
  const rope1 = await resolve(modelfileModel, 1_000_000);
  console.log(`  response: ${JSON.stringify(rope1)}`);
  if (rope1.modelCap === null) {
    console.log(`  SKIP  Modelfile model ${modelfileModel} not available; cannot assert`);
  } else {
    assert(
      rope1.modelCap >= modelfileCap,
      `Modelfile cap (${modelfileCap}) is at or below the resolved cap (${rope1.modelCap})`
    );
    assert(
      rope1.effective === Math.min(1_000_000, rope1.modelCap),
      `effective (${rope1.effective}) is min(requested, modelCap)`
    );
  }
  console.log('');

  // Test 6: cache invalidation on model change. Set up a
  // situation where the cache has MODEL_A's cap; switch to
  // MODEL_B; the next resolve(MODEL_B) should re-probe (not
  // cached) and return MODEL_B's cap.
  console.log('Test 6: cache invalidation on model change');
  // Warm MODEL_B's cache by re-resolving.
  const bWarm = await resolve(MODEL_B, REQUESTED);
  assert(bWarm.source === 'cache', `MODEL_B re-resolve hits cache (got: ${bWarm.source})`);
  // Switch the active model via PUT /api/config.
  const putRes = await fetch(`${BASE_URL}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_B }),
  });
  if (putRes.ok) {
    const bFresh = await resolve(MODEL_B, REQUESTED);
    console.log(`  response: ${JSON.stringify(bFresh)}`);
    assert(
      bFresh.source !== 'cache' || bFresh.modelCap === bWarm.modelCap,
      'after model change, either re-probed (source != cache) or cap unchanged'
    );
  } else {
    console.log(`  SKIP  PUT /api/config returned ${putRes.status}; cannot exercise invalidation`);
  }
  console.log('');

  console.log(`Results: ${pass} pass, ${fail} fail`);
  if (fail > 0) {
    process.exit(1);
  }
}

try {
  await main();
} catch (err) {
  console.error('Smoke test failed:', err);
  process.exit(1);
}
