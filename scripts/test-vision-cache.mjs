#!/usr/bin/env node
/**
 * Unit tests for the vision-support cache.
 *
 * Run with: npx tsx scripts/test-vision-cache.mjs
 *
 * No network, no live server, no Ollama. Mirrors
 * `scripts/test-numctx.mjs` exactly: pure-function imports,
 * assertEq/assertNull helpers, PASS/FAIL per case, exit 1 on
 * any failure.
 *
 * The tests cover the full surface of `src/services/visionCache.ts`
 * and the `parseVisionUnsupportedFromError` matcher from
 * `src/services/llmContextLimit.ts`. The legacy sync
 * `getLlmModelVisionSupport` (used by the /api/models projection
 * for non-async callers) is verified to retain its pre-fix
 * behaviour so we don't accidentally regress the Ollama path.
 *
 * Each test block is wrapped in an IIFE so the file works under
 * tsx's transpile-to-CJS mode as well as native ESM top-level
 * await (the file is .mjs and Node 18+ supports both).
 */

import {
  clearVisionCache,
  getLlmModelVisionSupport,
  invalidateVisionCache,
  parseVisionUnsupportedFromError,
  recordDiscoveredNonVision,
  resolveVisionSupport,
} from '../src/services/llm.ts';

let pass = 0;
let fail = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected: ${expected}\n        actual:   ${actual}`);
    fail += 1;
  }
}

function assertDeepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected: ${e}\n        actual:   ${a}`);
    fail += 1;
  }
}

const URL = 'http://localhost:11434';
const URL2 = 'http://other-host:9999';

// ── resolveVisionSupport — openai-compatible optimistic default ───────────

console.log('resolveVisionSupport — openai-compatible optimistic default');
await (async () => {
  clearVisionCache();
  const r = await resolveVisionSupport(URL, 'm1', 'openai-compatible');
  assertDeepEq(
    r,
    { state: 'supported', source: 'default' },
    'first call returns the openai-compatible default'
  );
})();

console.log('resolveVisionSupport — ollama pessimistic default');
await (async () => {
  clearVisionCache();
  const r = await resolveVisionSupport(URL, 'm2', 'ollama');
  assertDeepEq(
    r,
    { state: 'unsupported', source: 'default' },
    'first call returns the ollama pessimistic default'
  );
})();

console.log('resolveVisionSupport — probe respected for ollama, ignored for openai-compatible');
await (async () => {
  clearVisionCache();
  // ollama + probe(true) → supported/probe (uses capabilities)
  const r1 = await resolveVisionSupport(URL, 'm3', 'ollama', () => true);
  assertDeepEq(
    r1,
    { state: 'supported', source: 'probe' },
    'ollama + probe(true) → supported/probe'
  );
  // ollama + probe(false) → unsupported/probe (capabilities missing vision)
  const r2 = await resolveVisionSupport(URL2, 'm3', 'ollama', () => false);
  assertDeepEq(
    r2,
    { state: 'unsupported', source: 'probe' },
    'ollama + probe(false) → unsupported/probe'
  );
  // openai-compatible + probe(true) → supported/default (probe ignored, optimistic default wins)
  const r3 = await resolveVisionSupport(URL, 'm3b', 'openai-compatible', () => true);
  assertDeepEq(
    r3,
    { state: 'supported', source: 'default' },
    'openai-compatible + probe(true) → supported/default (probe ignored)'
  );
  // openai-compatible + probe(false) → supported/default (probe ignored, no false-poisoning)
  const r4 = await resolveVisionSupport(URL2, 'm3b', 'openai-compatible', () => false);
  assertDeepEq(
    r4,
    { state: 'supported', source: 'default' },
    'openai-compatible + probe(false) → supported/default (probe ignored, no false-poisoning)'
  );
})();

console.log('resolveVisionSupport — async probe is awaited');
await (async () => {
  clearVisionCache();
  // ollama so the probe is actually consulted (openai-compatible ignores the probe).
  const r = await resolveVisionSupport(URL, 'm4', 'ollama', async () => {
    await Promise.resolve();
    return true;
  });
  assertDeepEq(r, { state: 'supported', source: 'probe' }, 'async ollama probe(true) is awaited');
})();

console.log('resolveVisionSupport — Ollama probe refreshes weak default');
await (async () => {
  clearVisionCache();
  const initial = await resolveVisionSupport(URL, 'warmup', 'ollama');
  assertDeepEq(
    initial,
    { state: 'unsupported', source: 'default' },
    'no-probe Ollama warmup uses the conservative default'
  );
  const probed = await resolveVisionSupport(URL, 'warmup', 'ollama', () => true);
  assertDeepEq(
    probed,
    { state: 'supported', source: 'probe' },
    'successful Ollama probe refreshes the weak default'
  );
  const cached = await resolveVisionSupport(URL, 'warmup', 'ollama');
  assertDeepEq(
    cached,
    { state: 'supported', source: 'cache' },
    'refreshed Ollama probe remains cached'
  );
})();

console.log('resolveVisionSupport — discovered rejection beats later Ollama probe');
await (async () => {
  clearVisionCache();
  recordDiscoveredNonVision(URL, 'discovered', 'ollama');
  const r = await resolveVisionSupport(URL, 'discovered', 'ollama', () => true);
  assertDeepEq(
    r,
    { state: 'unsupported', source: 'cache' },
    'runtime-discovered unsupported remains authoritative over probe'
  );
})();

console.log('resolveVisionSupport — probe failure preserves cache and falls back safely');
await (async () => {
  clearVisionCache();
  await resolveVisionSupport(URL, 'probe-failure-cached', 'ollama', () => true);
  const cached = await resolveVisionSupport(URL, 'probe-failure-cached', 'ollama', () => {
    throw new Error('probe unavailable');
  });
  assertDeepEq(
    cached,
    { state: 'supported', source: 'cache' },
    'failed probe preserves existing Ollama cache'
  );
  clearVisionCache();
  const fallback = await resolveVisionSupport(URL, 'probe-failure-empty', 'ollama', () => {
    throw new Error('probe unavailable');
  });
  assertDeepEq(
    fallback,
    { state: 'unsupported', source: 'default' },
    'failed probe without cache falls back to Ollama default'
  );
})();

console.log('resolveVisionSupport — different (baseUrl, model) keys are independent');
await (async () => {
  clearVisionCache();
  const r1 = await resolveVisionSupport(URL, 'shared', 'openai-compatible');
  const r2 = await resolveVisionSupport(URL2, 'shared', 'openai-compatible');
  assertEq(r1.state, 'supported', 'first (url, shared) is supported');
  assertEq(r2.state, 'supported', 'second (url2, shared) is supported (independent key)');
  const r3 = await resolveVisionSupport(URL, 'shared', 'openai-compatible');
  assertEq(r3.source, 'cache', 'first key is cached after the second lookup');
})();

console.log(
  'resolveVisionSupport — chat route and /api/models agree on the openai-compatible default'
);
await (async () => {
  clearVisionCache();
  // Simulate the chat route (with a probe that historically poisoned the cache).
  const chatRoute = await resolveVisionSupport(
    URL,
    'shared-model',
    'openai-compatible',
    () => false
  );
  // Simulate the /api/models route (no probe).
  const modelsRoute = await resolveVisionSupport(URL, 'shared-model', 'openai-compatible');
  assertDeepEq(
    chatRoute,
    { state: 'supported', source: 'default' },
    'chat route yields optimistic default for openai-compatible'
  );
  assertDeepEq(
    modelsRoute,
    { state: 'supported', source: 'cache' },
    '/api/models reads the same cache entry the chat route wrote'
  );
})();

console.log('');

// ── recordDiscoveredNonVision ──────────────────────────────────────────────

console.log('recordDiscoveredNonVision — flips the cached state to unsupported');
await (async () => {
  clearVisionCache();
  await resolveVisionSupport(URL, 'm6', 'openai-compatible');
  recordDiscoveredNonVision(URL, 'm6', 'openai-compatible');
  const r = await resolveVisionSupport(URL, 'm6', 'openai-compatible');
  assertDeepEq(
    r,
    { state: 'unsupported', source: 'cache' },
    '400-driven record flips state to unsupported'
  );
})();

console.log('recordDiscoveredNonVision — 400 catch flips openai-compatible default → unsupported');
await (async () => {
  clearVisionCache();
  // Probe-ignored default for openai-compatible.
  const r1 = await resolveVisionSupport(URL, 'flipped', 'openai-compatible', () => false);
  assertEq(r1.state, 'supported', 'initial state is supported (optimistic default)');
  // Simulate the chat route's 400 catch calling recordDiscoveredNonVision.
  recordDiscoveredNonVision(URL, 'flipped', 'openai-compatible');
  // Next chat turn reads the flipped state.
  const r2 = await resolveVisionSupport(URL, 'flipped', 'openai-compatible');
  assertDeepEq(
    r2,
    { state: 'unsupported', source: 'cache' },
    'next read returns the 400-driven unsupported state'
  );
})();

console.log('recordDiscoveredNonVision — also affects entries that started as probe-cached');
await (async () => {
  clearVisionCache();
  await resolveVisionSupport(URL, 'm7', 'ollama', () => true);
  recordDiscoveredNonVision(URL, 'm7', 'ollama');
  const r = await resolveVisionSupport(URL, 'm7', 'ollama');
  assertDeepEq(
    r,
    { state: 'unsupported', source: 'cache' },
    'probe-cached supported is also flipped to unsupported'
  );
})();

console.log('');

// ── invalidateVisionCache ──────────────────────────────────────────────────

console.log('invalidateVisionCache — targeted (baseUrl, model)');
await (async () => {
  clearVisionCache();
  await resolveVisionSupport(URL, 'm8', 'openai-compatible');
  invalidateVisionCache(URL, 'm8');
  const r = await resolveVisionSupport(URL, 'm8', 'openai-compatible');
  assertDeepEq(
    r,
    { state: 'supported', source: 'default' },
    'invalidate restores the default on next call'
  );
})();

console.log('invalidateVisionCache — baseUrl-only wipes all entries for that baseUrl');
await (async () => {
  clearVisionCache();
  await resolveVisionSupport(URL, 'a', 'openai-compatible');
  await resolveVisionSupport(URL, 'b', 'openai-compatible');
  await resolveVisionSupport(URL2, 'a', 'openai-compatible');
  invalidateVisionCache(URL);
  const r1 = await resolveVisionSupport(URL, 'a', 'openai-compatible');
  const r2 = await resolveVisionSupport(URL, 'b', 'openai-compatible');
  const r3 = await resolveVisionSupport(URL2, 'a', 'openai-compatible');
  assertEq(r1.source, 'default', 'URL/a was wiped (source = default again)');
  assertEq(r2.source, 'default', 'URL/b was wiped (source = default again)');
  assertEq(r3.source, 'cache', 'URL2/a is unaffected (still cached)');
})();

console.log('invalidateVisionCache — no args wipes everything');
await (async () => {
  clearVisionCache();
  await resolveVisionSupport(URL, 'x', 'openai-compatible');
  await resolveVisionSupport(URL2, 'y', 'ollama');
  invalidateVisionCache();
  const r1 = await resolveVisionSupport(URL, 'x', 'openai-compatible');
  const r2 = await resolveVisionSupport(URL2, 'y', 'ollama');
  assertEq(r1.source, 'default', 'URL/x was wiped');
  assertEq(r2.source, 'default', 'URL2/y was wiped');
})();

console.log('invalidateVisionCache — no-op on empty cache does not throw');
await (async () => {
  clearVisionCache();
  try {
    invalidateVisionCache();
    invalidateVisionCache('http://anywhere');
    invalidateVisionCache('http://anywhere', 'anymodel');
    console.log('  PASS  invalidation on empty cache does not throw');
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  invalidation on empty cache threw: ${err}`);
    fail += 1;
  }
})();

console.log('');

// ── parseVisionUnsupportedFromError ───────────────────────────────────────

console.log('parseVisionUnsupportedFromError — common 400 phrasings');
assertEq(
  parseVisionUnsupportedFromError('Image input is not supported'),
  true,
  '"Image input is not supported" → true'
);
assertEq(
  parseVisionUnsupportedFromError('image input is not supported by this model'),
  true,
  '"image input is not supported by this model" → true'
);
assertEq(
  parseVisionUnsupportedFromError('Image input is not allowed'),
  true,
  '"Image input is not allowed" → true'
);
assertEq(
  parseVisionUnsupportedFromError('This model does not support image'),
  true,
  '"This model does not support image" → true'
);
assertEq(
  parseVisionUnsupportedFromError('Model does not support vision'),
  true,
  '"Model does not support vision" → true'
);
assertEq(
  parseVisionUnsupportedFromError('Model does not support multimodal input'),
  true,
  '"Model does not support multimodal input" → true'
);
assertEq(
  parseVisionUnsupportedFromError('Vision input not supported'),
  true,
  '"Vision input not supported" → true'
);
assertEq(
  parseVisionUnsupportedFromError('Vision image not supported'),
  true,
  '"Vision image not supported" → true'
);
assertEq(
  parseVisionUnsupportedFromError('The model does not accept images'),
  true,
  '"The model does not accept images" → true'
);
assertEq(
  parseVisionUnsupportedFromError('The model does not accept image_url content'),
  true,
  '"The model does not accept image_url content" → true'
);
assertEq(
  parseVisionUnsupportedFromError('image_url is not supported'),
  true,
  '"image_url is not supported" → true'
);
assertEq(
  parseVisionUnsupportedFromError('Unsupported content type: image/png'),
  true,
  '"Unsupported content type: image/png" → true'
);
assertEq(
  parseVisionUnsupportedFromError('Unsupported part type: image'),
  true,
  '"Unsupported part type: image" → true'
);

console.log('parseVisionUnsupportedFromError — non-vision 400s do NOT match');
assertEq(
  parseVisionUnsupportedFromError("This model's maximum context length is 4096 tokens"),
  false,
  'context-length 400 → false'
);
assertEq(parseVisionUnsupportedFromError('Invalid API key'), false, '"Invalid API key" → false');
assertEq(
  parseVisionUnsupportedFromError('Rate limit exceeded'),
  false,
  '"Rate limit exceeded" → false'
);
assertEq(
  parseVisionUnsupportedFromError('Internal server error'),
  false,
  '"Internal server error" → false'
);
assertEq(parseVisionUnsupportedFromError('Model not found'), false, '"Model not found" → false');
assertEq(
  parseVisionUnsupportedFromError('Bad Request: missing required field "model"'),
  false,
  'missing-field 400 → false'
);

console.log('parseVisionUnsupportedFromError — defensive against bad input');
assertEq(parseVisionUnsupportedFromError(''), false, 'empty string → false');
assertEq(parseVisionUnsupportedFromError(null), false, 'null → false');
assertEq(parseVisionUnsupportedFromError(undefined), false, 'undefined → false');
assertEq(parseVisionUnsupportedFromError(42), false, 'number → false');

console.log('');

// ── getLlmModelVisionSupport (legacy sync, used by /api/models) ───────────

console.log('getLlmModelVisionSupport — sync heuristic is unchanged');
assertEq(getLlmModelVisionSupport({ capabilities: ['vision'] }), true, '["vision"] → true');
assertEq(getLlmModelVisionSupport({ capabilities: ['multimodal'] }), true, '["multimodal"] → true');
assertEq(getLlmModelVisionSupport({ capabilities: ['image'] }), true, '["image"] → true');
assertEq(
  getLlmModelVisionSupport({ capabilities: ['completion'] }),
  false,
  '["completion"] → false (no vision capability)'
);
assertEq(getLlmModelVisionSupport({ capabilities: [] }), false, '[] → false');
assertEq(getLlmModelVisionSupport({}), false, '{} → false (no capabilities key)');
assertEq(
  getLlmModelVisionSupport({ capabilities: 'vision' }),
  false,
  'string capability → false (must be array)'
);
assertEq(getLlmModelVisionSupport(null), false, 'null → false (defensive)');

console.log('');

// ── summary ───────────────────────────────────────────────────────────────

console.log(`Results: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  process.exit(1);
}
