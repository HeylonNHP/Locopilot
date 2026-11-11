/**
 * Unit tests for the sampling-parameter support cache.
 *
 * No network, no live server, no Ollama. Mirrors
 * `tests/vision-cache.test.mjs` exactly: pure-function imports,
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

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { parseUnsupportedParamFromError } from '../src/services/llmContextLimit.ts';
import {
  clearSamplingParamCache,
  invalidateSamplingParamCache,
  recordDiscoveredUnsupportedParam,
  resolveSamplingParamSupport,
  resolveSamplingParamSupportMap,
  SAMPLING_PARAM_NAMES,
} from '../src/services/samplingParamsCache.ts';

const URL = 'http://localhost:11434';
const URL_ROUTER = 'https://openrouter.ai/api';
const MODEL = 'gpt-5.6-luna';
const MODEL_OK = 'gemini-2.5-pro';

describe('parseUnsupportedParamFromError', () => {
  test('real upstream phrasings', () => {
    // OpenAI-style: <param> is not supported
    expect(
      parseUnsupportedParamFromError(
        "400 Bad Request: 'temperature' is not supported by this model"
      )
    ).toBe('temperature');
    // vLLM-style: does not support <param>
    expect(parseUnsupportedParamFromError('Error: does not support temperature')).toBe(
      'temperature'
    );
    // Anthropic-style: does not accept <param>
    expect(parseUnsupportedParamFromError('Error: Model does not accept top_p')).toBe('top_p');
    // unsupported parameter:
    expect(
      parseUnsupportedParamFromError("Error: unsupported parameter: 'frequency_penalty'")
    ).toBe('frequency_penalty');
    // unknown parameter <param>
    expect(parseUnsupportedParamFromError('Error: unknown parameter seed')).toBe('seed');
    // value not supported for parameter
    expect(parseUnsupportedParamFromError('Error: value not supported for parameter `stop`')).toBe(
      'stop'
    );
    // Unrecognized request argument supplied
    expect(
      parseUnsupportedParamFromError('Error: Unrecognized request argument supplied: logit_bias')
    ).toBe('logit_bias');
  });

  test('null on no match', () => {
    // empty string
    expect(parseUnsupportedParamFromError('')).toBeNull();
    // unrelated error
    expect(parseUnsupportedParamFromError('some other error')).toBeNull();
    // context-length error (NOT a sampling param)
    expect(parseUnsupportedParamFromError('Context length exceeded: 8192 tokens')).toBeNull();
    // rate limit
    expect(parseUnsupportedParamFromError('rate limit exceeded')).toBeNull();
    // 500
    expect(parseUnsupportedParamFromError('internal server error')).toBeNull();
  });
});

describe('resolveSamplingParamSupport', () => {
  beforeEach(() => {
    clearSamplingParamCache();
  });

  afterEach(() => {
    clearSamplingParamCache();
  });

  test('optimistic default', async () => {
    const r = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    // openai-compatible default is supported
    expect(r.state).toBe('supported');
    // first read is from default
    expect(r.source).toBe('default');
  });

  test('probe writes cache', async () => {
    const r = await resolveSamplingParamSupport(
      URL,
      MODEL,
      'temperature',
      'openai-compatible',
      () => Promise.resolve('unsupported')
    );
    // probe verdict is honoured
    expect(r.state).toBe('unsupported');
    // source is probe
    expect(r.source).toBe('probe');
    const r2 = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    // cache retains the verdict
    expect(r2.state).toBe('unsupported');
    // source is cache on second read
    expect(r2.source).toBe('cache');
  });

  test('failed probe preserves existing cache', async () => {
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
    // failed probe keeps prior verdict
    expect(r.state).toBe('unsupported');
    // failed probe reads from cache
    expect(r.source).toBe('cache');
  });

  test('discovered beats later probe', async () => {
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
    // discovered wins over later probe
    expect(r.state).toBe('unsupported');
    // source is cache
    expect(r.source).toBe('cache');
  });

  test('different params are independent', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    const r = await resolveSamplingParamSupport(URL, MODEL, 'top_p', 'openai-compatible', () =>
      Promise.resolve('supported')
    );
    // top_p unaffected by temperature verdict
    expect(r.state).toBe('supported');
    // fresh probe on top_p
    expect(r.source).toBe('probe');
  });

  test('different baseUrls are independent', async () => {
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
    // different baseUrl → independent cache
    expect(r.state).toBe('supported');
  });

  test('different providers are independent', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    const r = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'ollama');
    // different provider → independent cache
    expect(r.state).toBe('supported');
    // ollama default is supported
    expect(r.source).toBe('default');
  });
});

describe('resolveSamplingParamSupportMap', () => {
  beforeEach(() => {
    clearSamplingParamCache();
  });

  afterEach(() => {
    clearSamplingParamCache();
  });

  test('full registry', async () => {
    const r = await resolveSamplingParamSupportMap(URL, MODEL, 'openai-compatible', () => ({
      temperature: false,
      top_p: true,
    }));
    // temperature from probe
    expect(r.temperature.state).toBe('unsupported');
    // top_p from probe
    expect(r.top_p.state).toBe('supported');
    // absent param → default
    expect(r.frequency_penalty.state).toBe('supported');
    // absent param is source=default
    expect(r.frequency_penalty.source).toBe('default');
    // the result has an entry for every sampling parameter
    for (const param of SAMPLING_PARAM_NAMES) {
      expect(r).toHaveProperty(param);
    }
  });

  test('missing probe returns defaults', async () => {
    const r = await resolveSamplingParamSupportMap(URL, MODEL_OK, 'openai-compatible');
    for (const param of SAMPLING_PARAM_NAMES) {
      expect(r[param].state).toBe('supported');
    }
  });
});

describe('invalidateSamplingParamCache', () => {
  beforeEach(() => {
    clearSamplingParamCache();
  });

  afterEach(() => {
    clearSamplingParamCache();
  });

  test('single param', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    await resolveSamplingParamSupport(URL, MODEL, 'top_p', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    invalidateSamplingParamCache(URL, MODEL, 'openai-compatible', 'temperature');
    const t = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    const p = await resolveSamplingParamSupport(URL, MODEL, 'top_p', 'openai-compatible');
    // temperature invalidated and falls back to default
    expect(t.source).toBe('default');
    // top_p untouched
    expect(p.source).toBe('cache');
  });

  test('all params for a model', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    await resolveSamplingParamSupport(URL, MODEL, 'top_p', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    invalidateSamplingParamCache(URL, MODEL, 'openai-compatible');
    const t = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    const p = await resolveSamplingParamSupport(URL, MODEL, 'top_p', 'openai-compatible');
    // temperature invalidated
    expect(t.source).toBe('default');
    // top_p invalidated
    expect(p.source).toBe('default');
  });

  test('all entries for a baseUrl', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    await resolveSamplingParamSupport(URL, MODEL_OK, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    invalidateSamplingParamCache(URL);
    const t = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    const t2 = await resolveSamplingParamSupport(URL, MODEL_OK, 'temperature', 'openai-compatible');
    // first model invalidated
    expect(t.source).toBe('default');
    // second model invalidated
    expect(t2.source).toBe('default');
  });

  test('no args clears everything', async () => {
    await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible', () =>
      Promise.resolve('unsupported')
    );
    invalidateSamplingParamCache();
    const t = await resolveSamplingParamSupport(URL, MODEL, 'temperature', 'openai-compatible');
    // entire cache cleared
    expect(t.source).toBe('default');
  });
});

describe('TTL expiry', () => {
  beforeEach(() => {
    clearSamplingParamCache();
  });

  afterEach(() => {
    clearSamplingParamCache();
  });

  test('discovered entry expires after 5 minutes', async () => {
    recordDiscoveredUnsupportedParam(URL, MODEL, 'temperature', 'openai-compatible', 1000);
    const r1 = await resolveSamplingParamSupport(
      URL,
      MODEL,
      'temperature',
      'openai-compatible',
      undefined,
      1000
    );
    // fresh discovered entry is honoured
    expect(r1.state).toBe('unsupported');
    const r2 = await resolveSamplingParamSupport(
      URL,
      MODEL,
      'temperature',
      'openai-compatible',
      undefined,
      1000 + 5 * 60 * 1000 + 1
    );
    // stale entry falls through to default
    expect(r2.state).toBe('supported');
    // stale entry uses default source
    expect(r2.source).toBe('default');
  });
});
