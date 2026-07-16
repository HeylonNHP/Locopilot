#!/usr/bin/env node
/**
 * Unit tests for the model-cap discovery logic.
 *
 * Run with: npx tsx scripts/test-numctx.mjs
 *
 * No network, no live server, no Ollama — the tests exercise the
 * pure functions in src/services/llmContextLimit.ts and the
 * cache-management surface in src/services/capResolver.ts.
 *
 * Each test prints PASS/FAIL with a one-line label. Exit code is 0
 * when all pass, 1 otherwise.
 *
 * The cap resolver's full resolveEffectiveNumCtx() (which calls
 * Ollama /api/ps and /api/show) is exercised end-to-end against a
 * running server in scripts/verify-numctx.mjs.
 */

import { clearCapCache, invalidateCapCache } from '../src/services/capResolver.ts';
import {
  findContextLimitInObject,
  getModelContextLimitFromInfo,
  parseContextLimitFromError,
  parseContextLimitFromText,
  parsePositiveInteger,
} from '../src/services/llmContextLimit.ts';

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

function assertNull(value, label) {
  if (value === null) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}\n        expected null\n        actual: ${value}`);
    fail += 1;
  }
}

// ── parsePositiveInteger ────────────────────────────────────────────────────

console.log('parsePositiveInteger');
assertEq(parsePositiveInteger(4096), 4096, 'integer 4096 → 4096');
assertEq(parsePositiveInteger('131072'), 131072, 'string "131072" → 131072');
assertNull(parsePositiveInteger(0), '0 → null');
assertNull(parsePositiveInteger(-1), '-1 → null');
assertNull(parsePositiveInteger(1.5), '1.5 → null (not integer)');
assertNull(parsePositiveInteger('abc'), 'string "abc" → null');
assertNull(parsePositiveInteger(null), 'null → null');
assertNull(parsePositiveInteger(undefined), 'undefined → null');
console.log('');

// ── findContextLimitInObject ────────────────────────────────────────────────

console.log('findContextLimitInObject');
assertEq(
  findContextLimitInObject({ 'general.context_length': 262144 }),
  262144,
  'root-level "general.context_length" → 262144'
);
assertEq(
  findContextLimitInObject({ model_info: { 'qwen3.context_length': 262144 } }),
  262144,
  'nested "qwen3.context_length" → 262144'
);
assertEq(
  findContextLimitInObject({
    model_info: { 'qwen2.embedding_length': 4096, 'qwen2.context_length': 32768 },
  }),
  32768,
  'qwen2.context_length wins over qwen2.embedding_length (regex anchors on alternation)'
);
assertNull(
  findContextLimitInObject({ 'qwen2.embedding_length': 4096 }),
  'qwen2.embedding_length alone does not match'
);
assertNull(
  findContextLimitInObject({
    'qwen3.attention.layer_norm_rms_epsilon': 1e-6,
  }),
  'qwen3.attention.layer_norm_rms_epsilon does not match'
);
assertNull(findContextLimitInObject({}), 'empty object → null');
assertNull(findContextLimitInObject(null), 'null input → null');
assertNull(
  findContextLimitInObject({ 'qwen3.context_length': 'not-a-number' }),
  'non-numeric value → null'
);
assertEq(
  findContextLimitInObject({
    model_info: { 'qwen3.context_length': 262144 },
    details: { max_context_length: 4096 },
  }),
  262144,
  'first matching key in Object.entries order wins'
);
console.log('');

// ── parseContextLimitFromText ───────────────────────────────────────────────

console.log('parseContextLimitFromText');
assertEq(parseContextLimitFromText('num_ctx 1048576\n'), 1048576, '"num_ctx 1048576" → 1048576');
assertEq(
  parseContextLimitFromText('context_length 32768'),
  32768,
  '"context_length 32768" → 32768'
);
assertEq(
  parseContextLimitFromText('PARAMETER num_ctx 262144\nstop\n'),
  262144,
  '"PARAMETER num_ctx 262144" → 262144 (Modelfile line)'
);
assertNull(parseContextLimitFromText(''), 'empty string → null');
assertNull(parseContextLimitFromText('stop\ntemperature 0.7'), 'no num_ctx → null');
assertNull(parseContextLimitFromText(null), 'null input → null');
assertNull(parseContextLimitFromText(42), 'non-string input → null');
console.log('');

// ── getModelContextLimitFromInfo (the order-sensitive entry point) ─────────

console.log('getModelContextLimitFromInfo — Modelfile wins over GGUF');
assertEq(
  getModelContextLimitFromInfo({
    parameters: 'num_ctx 1048576\n',
    model_info: { 'qwen3.context_length': 262144 },
  }),
  1048576,
  'Modelfile "num_ctx 1048576" + GGUF 262144 → 1048576 (RoPE-scaled)'
);

console.log('getModelContextLimitFromInfo — falls back to GGUF when no Modelfile override');
assertEq(
  getModelContextLimitFromInfo({
    parameters: 'stop\ntemperature 0.7\n',
    model_info: { 'qwen3.context_length': 262144 },
  }),
  262144,
  'parameters without num_ctx → 262144 from model_info'
);

console.log('getModelContextLimitFromInfo — null when nothing matches');
assertNull(
  getModelContextLimitFromInfo({
    parameters: 'stop\n',
    model_info: { 'qwen3.embedding_length': 4096 },
  }),
  'no num_ctx, no context_length → null'
);

console.log('getModelContextLimitFromInfo — modelfile string is also scanned');
assertEq(
  getModelContextLimitFromInfo({
    modelfile: 'FROM qwen3:35b\nPARAMETER num_ctx 524288\n',
    model_info: { 'qwen3.context_length': 262144 },
  }),
  524288,
  'modelfile with PARAMETER num_ctx → 524288'
);

console.log('getModelContextLimitFromInfo — OpenAI-compatible synthetic payload');
assertEq(
  getModelContextLimitFromInfo({
    model_info: { max_context_length: 8192 },
  }),
  8192,
  'synthetic OpenAI model_info with max_context_length → 8192'
);
console.log('');

// ── parseContextLimitFromError ──────────────────────────────────────────────

console.log('parseContextLimitFromError');
assertEq(
  parseContextLimitFromError(
    "This model's maximum context length is 4096 tokens. Please reduce the length of the messages."
  ),
  4096,
  'OpenAI-style 4096 → 4096'
);
assertEq(
  parseContextLimitFromError(
    "This model's maximum context length is 16385 tokens. Please reduce the length of the messages."
  ),
  16385,
  'OpenAI-style 16385 → 16385'
);
assertNull(parseContextLimitFromError('Invalid API key'), 'unrelated error → null');
assertNull(
  parseContextLimitFromError('context length exceeded: 4122 > 4096'),
  'Ollama-style error (no "this model\'s" prefix) → null'
);
console.log('');

// ── invalidateCapCache (cache surface, no network) ─────────────────────────

console.log('invalidateCapCache — targeted invalidation');
// We exercise the cache through the public invalidation API. Since
// the internal cache Map is module-private, we can only verify
// invalidation by observing that subsequent calls to the public
// API don't throw and the cache surface is consistent.
clearCapCache();
try {
  invalidateCapCache(); // no-op on empty cache
  invalidateCapCache('http://localhost:11434'); // no-op on empty cache
  invalidateCapCache('http://localhost:11434', 'qwen3.6:35b'); // no-op on empty cache
  console.log('  PASS  invalidation on empty cache does not throw');
  pass += 1;
} catch (err) {
  console.error(`  FAIL  invalidation on empty cache threw: ${err}`);
  fail += 1;
}

try {
  // Round-trip via clearCapCache: seed something, clear it, verify
  // no error.
  clearCapCache();
  invalidateCapCache('http://anywhere', 'anymodel');
  clearCapCache();
  console.log('  PASS  clearCapCache + invalidateCapCache compose cleanly');
  pass += 1;
} catch (err) {
  console.error(`  FAIL  clearCapCache + invalidateCapCache threw: ${err}`);
  fail += 1;
}

console.log('');

// ── summary ────────────────────────────────────────────────────────────────

console.log(`Results: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  process.exit(1);
}
