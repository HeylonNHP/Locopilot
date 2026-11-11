/**
 * Unit tests for the vision-support cache.
 *
 * No network, no live server, no Ollama. Mirrors
 * `tests/numctx.test.mjs` exactly: pure-function imports,
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

import { beforeEach, describe, expect, test } from '@jest/globals';

import {
  clearVisionCache,
  getLlmModelVisionSupport,
  invalidateVisionCache,
  parseVisionUnsupportedFromError,
  recordDiscoveredNonVision,
  resolveVisionSupport,
} from '../src/services/llm.ts';

const URL = 'http://localhost:11434';
const URL2 = 'http://other-host:9999';

describe('resolveVisionSupport', () => {
  beforeEach(() => {
    clearVisionCache();
  });

  test('openai-compatible optimistic default', async () => {
    const r = await resolveVisionSupport(URL, 'm1', 'openai-compatible');
    // first call returns the openai-compatible default
    expect(r).toEqual({ state: 'supported', source: 'default' });
  });

  test('ollama pessimistic default', async () => {
    const r = await resolveVisionSupport(URL, 'm2', 'ollama');
    // first call returns the ollama pessimistic default
    expect(r).toEqual({ state: 'unsupported', source: 'default' });
  });

  test('probe respected for ollama, ignored for openai-compatible', async () => {
    // ollama + probe(true) → supported/probe (uses capabilities)
    const r1 = await resolveVisionSupport(URL, 'm3', 'ollama', () => true);
    // ollama + probe(true) → supported/probe
    expect(r1).toEqual({ state: 'supported', source: 'probe' });
    // ollama + probe(false) → unsupported/probe (capabilities missing vision)
    const r2 = await resolveVisionSupport(URL2, 'm3', 'ollama', () => false);
    // ollama + probe(false) → unsupported/probe
    expect(r2).toEqual({ state: 'unsupported', source: 'probe' });
    // openai-compatible + probe(true) → supported/default (probe ignored, optimistic default wins)
    const r3 = await resolveVisionSupport(URL, 'm3b', 'openai-compatible', () => true);
    // openai-compatible + probe(true) → supported/default (probe ignored)
    expect(r3).toEqual({ state: 'supported', source: 'default' });
    // openai-compatible + probe(false) → supported/default (probe ignored, no false-poisoning)
    const r4 = await resolveVisionSupport(URL2, 'm3b', 'openai-compatible', () => false);
    // openai-compatible + probe(false) → supported/default (probe ignored, no false-poisoning)
    expect(r4).toEqual({ state: 'supported', source: 'default' });
  });

  test('async probe is awaited', async () => {
    // ollama so the probe is actually consulted (openai-compatible ignores the probe).
    const r = await resolveVisionSupport(URL, 'm4', 'ollama', async () => {
      await Promise.resolve();
      return true;
    });
    // async ollama probe(true) is awaited
    expect(r).toEqual({ state: 'supported', source: 'probe' });
  });

  test('Ollama probe refreshes weak default', async () => {
    const initial = await resolveVisionSupport(URL, 'warmup', 'ollama');
    // no-probe Ollama warmup uses the conservative default
    expect(initial).toEqual({ state: 'unsupported', source: 'default' });
    const probed = await resolveVisionSupport(URL, 'warmup', 'ollama', () => true);
    // successful Ollama probe refreshes the weak default
    expect(probed).toEqual({ state: 'supported', source: 'probe' });
    const cached = await resolveVisionSupport(URL, 'warmup', 'ollama');
    // refreshed Ollama probe remains cached
    expect(cached).toEqual({ state: 'supported', source: 'cache' });
  });

  test('discovered rejection beats later Ollama probe', async () => {
    recordDiscoveredNonVision(URL, 'discovered', 'ollama');
    const r = await resolveVisionSupport(URL, 'discovered', 'ollama', () => true);
    // runtime-discovered unsupported remains authoritative over probe
    expect(r).toEqual({ state: 'unsupported', source: 'cache' });
  });

  test('probe failure preserves cache and falls back safely', async () => {
    await resolveVisionSupport(URL, 'probe-failure-cached', 'ollama', () => true);
    const cached = await resolveVisionSupport(URL, 'probe-failure-cached', 'ollama', () => {
      throw new Error('probe unavailable');
    });
    // failed probe preserves existing Ollama cache
    expect(cached).toEqual({ state: 'supported', source: 'cache' });
    const fallback = await resolveVisionSupport(URL, 'probe-failure-empty', 'ollama', () => {
      throw new Error('probe unavailable');
    });
    // failed probe without cache falls back to Ollama default
    expect(fallback).toEqual({ state: 'unsupported', source: 'default' });
  });

  test('different (baseUrl, model) keys are independent', async () => {
    const r1 = await resolveVisionSupport(URL, 'shared', 'openai-compatible');
    const r2 = await resolveVisionSupport(URL2, 'shared', 'openai-compatible');
    // first (url, shared) is supported
    expect(r1.state).toBe('supported');
    // second (url2, shared) is supported (independent key)
    expect(r2.state).toBe('supported');
    const r3 = await resolveVisionSupport(URL, 'shared', 'openai-compatible');
    // first key is cached after the second lookup
    expect(r3.source).toBe('cache');
  });

  test('chat route and /api/models agree on the openai-compatible default', async () => {
    // Simulate the chat route (with a probe that historically poisoned the cache).
    const chatRoute = await resolveVisionSupport(
      URL,
      'shared-model',
      'openai-compatible',
      () => false
    );
    // Simulate the /api/models route (no probe).
    const modelsRoute = await resolveVisionSupport(URL, 'shared-model', 'openai-compatible');
    // chat route yields optimistic default for openai-compatible
    expect(chatRoute).toEqual({ state: 'supported', source: 'default' });
    // /api/models reads the same cache entry the chat route wrote
    expect(modelsRoute).toEqual({ state: 'supported', source: 'cache' });
  });
});

describe('recordDiscoveredNonVision', () => {
  beforeEach(() => {
    clearVisionCache();
  });

  test('flips the cached state to unsupported', async () => {
    await resolveVisionSupport(URL, 'm6', 'openai-compatible');
    recordDiscoveredNonVision(URL, 'm6', 'openai-compatible');
    const r = await resolveVisionSupport(URL, 'm6', 'openai-compatible');
    // 400-driven record flips state to unsupported
    expect(r).toEqual({ state: 'unsupported', source: 'cache' });
  });

  test('400 catch flips openai-compatible default → unsupported', async () => {
    // Probe-ignored default for openai-compatible.
    const r1 = await resolveVisionSupport(URL, 'flipped', 'openai-compatible', () => false);
    // initial state is supported (optimistic default)
    expect(r1.state).toBe('supported');
    // Simulate the chat route's 400 catch calling recordDiscoveredNonVision.
    recordDiscoveredNonVision(URL, 'flipped', 'openai-compatible');
    // Next chat turn reads the flipped state.
    const r2 = await resolveVisionSupport(URL, 'flipped', 'openai-compatible');
    // next read returns the 400-driven unsupported state
    expect(r2).toEqual({ state: 'unsupported', source: 'cache' });
  });

  test('also affects entries that started as probe-cached', async () => {
    await resolveVisionSupport(URL, 'm7', 'ollama', () => true);
    recordDiscoveredNonVision(URL, 'm7', 'ollama');
    const r = await resolveVisionSupport(URL, 'm7', 'ollama');
    // probe-cached supported is also flipped to unsupported
    expect(r).toEqual({ state: 'unsupported', source: 'cache' });
  });
});

describe('invalidateVisionCache', () => {
  beforeEach(() => {
    clearVisionCache();
  });

  test('targeted (baseUrl, model)', async () => {
    await resolveVisionSupport(URL, 'm8', 'openai-compatible');
    invalidateVisionCache(URL, 'm8');
    const r = await resolveVisionSupport(URL, 'm8', 'openai-compatible');
    // invalidate restores the default on next call
    expect(r).toEqual({ state: 'supported', source: 'default' });
  });

  test('baseUrl-only wipes all entries for that baseUrl', async () => {
    await resolveVisionSupport(URL, 'a', 'openai-compatible');
    await resolveVisionSupport(URL, 'b', 'openai-compatible');
    await resolveVisionSupport(URL2, 'a', 'openai-compatible');
    invalidateVisionCache(URL);
    const r1 = await resolveVisionSupport(URL, 'a', 'openai-compatible');
    const r2 = await resolveVisionSupport(URL, 'b', 'openai-compatible');
    const r3 = await resolveVisionSupport(URL2, 'a', 'openai-compatible');
    // URL/a was wiped (source = default again)
    expect(r1.source).toBe('default');
    // URL/b was wiped (source = default again)
    expect(r2.source).toBe('default');
    // URL2/a is unaffected (still cached)
    expect(r3.source).toBe('cache');
  });

  test('no args wipes everything', async () => {
    await resolveVisionSupport(URL, 'x', 'openai-compatible');
    await resolveVisionSupport(URL2, 'y', 'ollama');
    invalidateVisionCache();
    const r1 = await resolveVisionSupport(URL, 'x', 'openai-compatible');
    const r2 = await resolveVisionSupport(URL2, 'y', 'ollama');
    // URL/x was wiped
    expect(r1.source).toBe('default');
    // URL2/y was wiped
    expect(r2.source).toBe('default');
  });

  test('no-op on empty cache does not throw', () => {
    expect(() => {
      invalidateVisionCache();
      invalidateVisionCache('http://anywhere');
      invalidateVisionCache('http://anywhere', 'anymodel');
    }).not.toThrow();
  });
});

describe('parseVisionUnsupportedFromError', () => {
  beforeEach(() => {
    clearVisionCache();
  });

  describe('common 400 phrasings', () => {
    test.each([
      ['"Image input is not supported" → true', 'Image input is not supported', true],
      [
        '"image input is not supported by this model" → true',
        'image input is not supported by this model',
        true,
      ],
      ['"Image input is not allowed" → true', 'Image input is not allowed', true],
      ['"This model does not support image" → true', 'This model does not support image', true],
      ['"Model does not support vision" → true', 'Model does not support vision', true],
      [
        '"Model does not support multimodal input" → true',
        'Model does not support multimodal input',
        true,
      ],
      ['"Vision input not supported" → true', 'Vision input not supported', true],
      ['"Vision image not supported" → true', 'Vision image not supported', true],
      ['"The model does not accept images" → true', 'The model does not accept images', true],
      [
        '"The model does not accept image_url content" → true',
        'The model does not accept image_url content',
        true,
      ],
      ['"image_url is not supported" → true', 'image_url is not supported', true],
      ['"Unsupported content type: image/png" → true', 'Unsupported content type: image/png', true],
      ['"Unsupported part type: image" → true', 'Unsupported part type: image', true],
    ])('%s', (_label, input, expected) => {
      expect(parseVisionUnsupportedFromError(input)).toBe(expected);
    });
  });

  describe('non-vision 400s do NOT match', () => {
    test.each([
      ['context-length 400 → false', "This model's maximum context length is 4096 tokens", false],
      ['"Invalid API key" → false', 'Invalid API key', false],
      ['"Rate limit exceeded" → false', 'Rate limit exceeded', false],
      ['"Internal server error" → false', 'Internal server error', false],
      ['"Model not found" → false', 'Model not found', false],
      ['missing-field 400 → false', 'Bad Request: missing required field "model"', false],
    ])('%s', (_label, input, expected) => {
      expect(parseVisionUnsupportedFromError(input)).toBe(expected);
    });
  });

  describe('defensive against bad input', () => {
    test.each([
      ['empty string → false', '', false],
      ['null → false', null, false],
      ['undefined → false', undefined, false],
      ['number → false', 42, false],
    ])('%s', (_label, input, expected) => {
      expect(parseVisionUnsupportedFromError(input)).toBe(expected);
    });
  });
});

describe('getLlmModelVisionSupport', () => {
  beforeEach(() => {
    clearVisionCache();
  });

  describe('sync heuristic is unchanged', () => {
    test.each([
      ['["vision"] → true', { capabilities: ['vision'] }, true],
      ['["multimodal"] → true', { capabilities: ['multimodal'] }, true],
      ['["image"] → true', { capabilities: ['image'] }, true],
      ['["completion"] → false (no vision capability)', { capabilities: ['completion'] }, false],
      ['[] → false', { capabilities: [] }, false],
      ['{} → false (no capabilities key)', {}, false],
      ['string capability → false (must be array)', { capabilities: 'vision' }, false],
      ['null → false (defensive)', null, false],
    ])('%s', (_label, input, expected) => {
      expect(getLlmModelVisionSupport(input)).toBe(expected);
    });
  });
});
