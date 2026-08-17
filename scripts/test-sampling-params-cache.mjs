#!/usr/bin/env node
/**
 * Unit tests for the sampling-parameter support cache.
 *
 * Run with: npx tsx scripts/test-sampling-params-cache.mjs
 *
 * No network, no live server, no Ollama. Mirrors
 * `scripts/test-vision-cache.mjs` exactly: pure-function imports,
 * assertEq/assertNull/assertDeepEq helpers, PASS/FAIL per case,
 * exit 1 on any failure.
 *
 * The tests cover the full surface of
 * `src/services/samplingParamsCache.ts` and the
 * `parseUnsupportedParamFromError` matcher from
 * `src/services/llmContextLimit.ts`. The matcher is the riskiest
 * part of the design — false positives silently strip a sampling
 * knob the model actually accepts, so the false-positive coverage
 * is intentionally strict.
 */

import { parseUnsupportedParamFromError } from '../src/services/llmContextLimit.ts';
import {
  clearSamplingParamCache,
  invalidateSamplingParamCache,
  recordDiscoveredUnsupportedParam,
  resolveSamplingParamSupport,
  resolveSamplingParamSupportMap,
  SAMPLING_PARAM_NAMES,
} from '../src/services/samplingParamsCache.ts';

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

const URL = 'http://localhost:11434';
const URL_ROUTER = 'https://openrouter.ai/api';
const MODEL = 'gpt-5.6-luna';
const MODEL_OK = 'gemini-2.5-pro';

function block(name, fn) {
  console.log(`\n# ${name}`);
  clearSamplingParamCache();
  // `block` is fire-and-forget for synchronous test bodies and
  // `await`-aware for async ones: callers that pass an async fn
  // should `await block(...)` themselves. Sync callers can ignore
  // the returned promise.
  const result = fn();
  clearSamplingParamCache();
  return result;
}

block('parseUnsupportedParamFromError — real upstream phrasings', () => {
  assertEq(
    parseUnsupportedParamFromError("400 Bad Request: 'temperature' is not supported by this model"),
    'temperature',
    'OpenAI-style: <param> is not supported'
  );
  assertEq(
    parseUnsupportedParamFromError('Error: does not support temperature'),
    'temperature',
    'vLLM-style: does not support <param>'
  );
  assertEq(
    parseUnsupportedParamFromError('Error: Model does not accept top_p'),
    'top_p',
    'Anthropic-style: does not accept <param>'
  );
  assertEq(
    parseUnsupportedParamFromError("Error: unsupported parameter: 'frequency_penalty'"),
    'frequency_penalty',
    'unsupported parameter:'
  );
  assertEq(
    parseUnsupportedParamFromError('Error: unknown parameter seed'),
    'seed',
    'unknown parameter <param>'
  );
  assertEq(
    parseUnsupportedParamFromError('Error: value not supported for parameter `stop`'),
    'stop',
    'value not supported for parameter'
  );
  assertEq(
    parseUnsupportedParamFromError('Error: Unrecognized request argument supplied: logit_bias'),
    'logit_bias',
    'Unrecognized request argument supplied'
  );
});

block('parseUnsupportedParamFromError — null on no match', () => {
  assertNull(parseUnsupportedParamFromError(''), 'empty string');
  assertNull(parseUnsupportedParamFromError('some other error'), 'unrelated error');
  assertNull(
    parseUnsupportedParamFromError('Context length exceeded: 8192 tokens'),
    'context-length error (NOT a sampling param)'
  );
  assertNull(parseUnsupportedParamFromError('rate limit exceeded'), 'rate limit');
  assertNull(parseUnsupportedParamFromError('internal server error'), '500');
});

await (async () => {
  await block('resolveSamplingParamSupport — optimistic default', async () => {
    const r = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    assertEq(r.state, 'supported', 'openai-compatible default is supported');
    assertEq(r.source, 'default', 'first read is from default');
  });

  await block('resolveSamplingParamSupport — probe writes cache', async () => {
    const r = await resolveSamplingParamSupport(
      URL,
      MODEL,
      'temperature',
      'openai-compatible',
      () => Promise.resolve('unsupported')
    );
    assertEq(r.state, 'unsupported', 'probe verdict is honoured');
    assertEq(r.source, 'probe', 'source is probe');
    const r2 = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    assertEq(r2.state, 'unsupported', 'cache retains the verdict');
    assertEq(r2.source, 'cache', 'source is cache on second read');
  });

  await block('resolveSamplingParamSupport — failed probe preserves existing cache', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    const r = await resolveSamplingParamSupport(
      URL,
      MODEL,
      'temperature',
      'openai-compatible',
      () => Promise.reject(new Error('network'))
    );
    assertEq(r.state, 'unsupported', 'failed probe keeps prior verdict');
    assertEq(r.source, 'cache', 'failed probe reads from cache');
  });

  await block('resolveSamplingParamSupport — discovered beats later probe', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('supported')
    );
    recordDiscoveredUnsupportedParam(URL, MODEL, 'temperature', 'openai-compatible');
    const r = await resolveSamplingParamSupport(
      URL,
      MODEL,
      'temperature',
      'openai-compatible',
      () => Promise.resolve('supported')
    );
    assertEq(r.state, 'unsupported', 'discovered wins over later probe');
    assertEq(r.source, 'cache', 'source is cache');
  });

  await block('resolveSamplingParamSupport — different params are independent', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    const r = await resolveSamplingParamSupport(URL, MODEL, 'top_p', 'openai-compatible', () =>
      Promise.resolve('supported')
    );
    assertEq(r.state, 'supported', 'top_p unaffected by temperature verdict');
    assertEq(r.source, 'probe', 'fresh probe on top_p');
  });

  await block('resolveSamplingParamSupport — different baseUrls are independent', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    const r = await resolveSamplingParamSupport(
      URL_ROUTER,
      MODEL,
      'temperature',
      'openai-compatible',
      () => Promise.resolve('supported')
    );
    assertEq(r.state, 'supported', 'different baseUrl → independent cache');
  });

  await block('resolveSamplingParamSupport — different providers are independent', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    const r = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'ollama');
    assertEq(r.state, 'supported', 'different provider → independent cache');
    assertEq(r.source, 'default', 'ollama default is supported');
  });

  await block('resolveSamplingParamSupportMap — full registry', async () => {
    const r = await resolveSamplingParamSupportMap(URL, MODEL, 'openai-compatible', () => ({
      temperature: false,
      top_p: true,
    }));
    assertEq(r.temperature.state, 'unsupported', 'temperature from probe');
    assertEq(r.top_p.state, 'supported', 'top_p from probe');
    assertEq(r.frequency_penalty.state, 'supported', 'absent param → default');
    assertEq(r.frequency_penalty.source, 'default', 'absent param is source=default');
    for (const param of SAMPLING_PARAM_NAMES) {
      if (param in r) {
        pass += 1;
        console.log(`  PASS  result has ${param}`);
      } else {
        fail += 1;
        console.error(`  FAIL  result missing ${param}`);
      }
    }
  });

  await block('resolveSamplingParamSupportMap — missing probe returns defaults', async () => {
    const r = await resolveSamplingParamSupportMap(URL, MODEL_OK, 'openai-compatible');
    for (const param of SAMPLING_PARAM_NAMES) {
      assertEq(r[param].state, 'supported', `${param} default supported`);
    }
  });

  await block('invalidateSamplingParamCache — single param', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    await resolveSamplingParamSupport(URL, MODEL, 'top_p', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    invalidateSamplingParamCache(URL, MODEL, 'openai-compatible', 'temperature');
    const t = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    const p = await resolveSamplingParamSupport(URL, MODEL, 'top_p', 'openai-compatible');
    assertEq(t.source, 'default', 'temperature invalidated and falls back to default');
    assertEq(p.source, 'cache', 'top_p untouched');
  });

  await block('invalidateSamplingParamCache — all params for a model', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    await resolveSamplingParamSupport(URL, MODEL, 'top_p', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    invalidateSamplingParamCache(URL, MODEL, 'openai-compatible');
    const t = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    const p = await resolveSamplingParamSupport(URL, MODEL, 'top_p', 'openai-compatible');
    assertEq(t.source, 'default', 'temperature invalidated');
    assertEq(p.source, 'default', 'top_p invalidated');
  });

  await block('invalidateSamplingParamCache — all entries for a baseUrl', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    await resolveSamplingParamSupport(URL, MODEL_OK, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    invalidateSamplingParamCache(URL);
    const t = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    const t2 = await resolveSamplingParamSupport(URL, MODEL_OK, 'temperature', 'openai-compatible');
    assertEq(t.source, 'default', 'first model invalidated');
    assertEq(t2.source, 'default', 'second model invalidated');
  });

  await block('invalidateSamplingParamCache — no args clears everything', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    invalidateSamplingParamCache();
    const t = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    assertEq(t.source, 'default', 'entire cache cleared');
  });

  await block('TTL expiry — discovered entry expires after 5 minutes', async () => {
    recordDiscoveredUnsupportedParam(URL, MODEL, 'temperature', 'openai-compatible', 1000);
    const r1 = await resolveSamplingParamSupport(
      URL,
      MODEL,
      'temperature',
      'openai-compatible',
      undefined,
      1000
    );
    assertEq(r1.state, 'unsupported', 'fresh discovered entry is honoured');
    const r2 = await resolveSamplingParamSupport(
      URL,
      MODEL,
      'temperature',
      'openai-compatible',
      undefined,
      1000 + 5 * 60 * 1000 + 1
    );
    assertEq(r2.state, 'supported', 'stale entry falls through to default');
    assertEq(r2.source, 'default', 'stale entry uses default source');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
