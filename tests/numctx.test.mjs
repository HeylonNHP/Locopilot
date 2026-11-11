/**
 * Unit tests for the model-cap discovery logic.
 *
 * No network, no live server, no Ollama — the tests exercise the
 * pure functions in src/services/llmContextLimit.ts and the
 * cache-management surface in src/services/capResolver.ts.
 *
 * Each test prints PASS/FAIL with a one-line label. Exit code is 0
 * when all pass, 1 otherwise.
 *
 * The resolver itself is covered, with fake probes, in
 * tests/numctx-resolver.test.mjs, and end-to-end against a running
 * server in scripts/verify-numctx.mjs.
 */

import { describe, expect, test } from '@jest/globals';

import { clearCapCache, invalidateCapCache } from '../src/services/capResolver.ts';
import {
  findContextLimitInObject,
  getModelContextLimitFromInfo,
  parseContextLimitFromError,
  parseContextLimitFromText,
  parsePositiveInteger,
} from '../src/services/llmContextLimit.ts';

describe('parsePositiveInteger', () => {
  test.each([
    ['integer 4096 → 4096', 4096, 4096],
    ['string "131072" → 131072', '131072', 131072],
    ['0 → null', 0, null],
    ['-1 → null', -1, null],
    ['1.5 → null (not integer)', 1.5, null],
    ['string "abc" → null', 'abc', null],
    ['null → null', null, null],
    ['undefined → null', undefined, null],
  ])('%s', (_label, input, expected) => {
    expect(parsePositiveInteger(input)).toBe(expected);
  });
});

describe('findContextLimitInObject', () => {
  test.each([
    ['root-level "general.context_length" → 262144', { 'general.context_length': 262144 }, 262144],
    [
      'nested "qwen3.context_length" → 262144',
      { model_info: { 'qwen3.context_length': 262144 } },
      262144,
    ],
    [
      'qwen2.context_length wins over qwen2.embedding_length (regex anchors on alternation)',
      {
        model_info: { 'qwen2.embedding_length': 4096, 'qwen2.context_length': 32768 },
      },
      32768,
    ],
    ['qwen2.embedding_length alone does not match', { 'qwen2.embedding_length': 4096 }, null],
    [
      'qwen3.attention.layer_norm_rms_epsilon does not match',
      {
        'qwen3.attention.layer_norm_rms_epsilon': 1e-6,
      },
      null,
    ],
    ['empty object → null', {}, null],
    ['null input → null', null, null],
    ['non-numeric value → null', { 'qwen3.context_length': 'not-a-number' }, null],
    [
      'first matching key in Object.entries order wins',
      {
        model_info: { 'qwen3.context_length': 262144 },
        details: { max_context_length: 4096 },
      },
      262144,
    ],
  ])('%s', (_label, input, expected) => {
    expect(findContextLimitInObject(input)).toBe(expected);
  });

  // llama.cpp: llama-server's /v1/models entry carries the served window and
  // the GGUF training window under `meta`. The served `n_ctx` is the value the
  // server actually enforces, so it must win — and it must win regardless of
  // key order, since JSON field order is not a contract.
  test.each([
    [
      'llama.cpp meta.n_ctx → 262144',
      {
        model_info: {
          model: 'Ornith-1.5-35B-A3B-Heretic-MTP-APEX-I-Quality',
          meta: {
            vocab_type: true,
            n_vocab: 248320,
            n_ctx: 262144,
            n_ctx_train: 262144,
            n_embd: 2048,
          },
        },
      },
      262144,
    ],
    [
      'llama.cpp served n_ctx outranks n_ctx_train when the training value comes first',
      { meta: { n_ctx_train: 131072, n_ctx: 262144 } },
      262144,
    ],
    [
      'declared context_length outranks the GGUF training window (n_ctx_train)',
      { meta: { n_ctx_train: 131072 }, 'qwen3.context_length': 32768 },
      32768,
    ],
    [
      'n_ctx_train alone is still a usable (weakest) cap',
      { meta: { n_ctx_train: 262144 } },
      262144,
    ],
    [
      'llama.cpp meta without n_ctx/n_ctx_train → null',
      { meta: { n_vocab: 248320, n_embd: 2048 } },
      null,
    ],
    ['string-valued n_ctx is parsed like every other key', { meta: { n_ctx: '262144' } }, 262144],
  ])('%s', (_label, input, expected) => {
    expect(findContextLimitInObject(input)).toBe(expected);
  });
});

describe('parseContextLimitFromText', () => {
  test.each([
    ['"num_ctx 1048576" → 1048576', 'num_ctx 1048576\n', 1048576],
    ['"context_length 32768" → 32768', 'context_length 32768', 32768],
    [
      '"PARAMETER num_ctx 262144" → 262144 (Modelfile line)',
      'PARAMETER num_ctx 262144\nstop\n',
      262144,
    ],
    ['empty string → null', '', null],
    ['no num_ctx → null', 'stop\ntemperature 0.7', null],
    ['null input → null', null, null],
    ['non-string input → null', 42, null],
  ])('%s', (_label, input, expected) => {
    expect(parseContextLimitFromText(input)).toBe(expected);
  });
});

describe('getModelContextLimitFromInfo — Modelfile wins over GGUF', () => {
  test('Modelfile "num_ctx 1048576" + GGUF 262144 → 1048576 (RoPE-scaled)', () => {
    expect(
      getModelContextLimitFromInfo({
        parameters: 'num_ctx 1048576\n',
        model_info: { 'qwen3.context_length': 262144 },
      })
    ).toBe(1048576);
  });
});

describe('getModelContextLimitFromInfo — falls back to GGUF when no Modelfile override', () => {
  test('parameters without num_ctx → 262144 from model_info', () => {
    expect(
      getModelContextLimitFromInfo({
        parameters: 'stop\ntemperature 0.7\n',
        model_info: { 'qwen3.context_length': 262144 },
      })
    ).toBe(262144);
  });
});

describe('getModelContextLimitFromInfo — null when nothing matches', () => {
  test('no num_ctx, no context_length → null', () => {
    expect(
      getModelContextLimitFromInfo({
        parameters: 'stop\n',
        model_info: { 'qwen3.embedding_length': 4096 },
      })
    ).toBeNull();
  });
});

describe('getModelContextLimitFromInfo — modelfile string is also scanned', () => {
  test('modelfile with PARAMETER num_ctx → 524288', () => {
    expect(
      getModelContextLimitFromInfo({
        modelfile: 'FROM qwen3:35b\nPARAMETER num_ctx 524288\n',
        model_info: { 'qwen3.context_length': 262144 },
      })
    ).toBe(524288);
  });
});

describe('getModelContextLimitFromInfo — OpenAI-compatible synthetic payload', () => {
  test('synthetic OpenAI model_info with max_context_length → 8192', () => {
    expect(
      getModelContextLimitFromInfo({
        model_info: { max_context_length: 8192 },
      })
    ).toBe(8192);
  });
});

describe('getModelContextLimitFromInfo — llama.cpp /v1/models payload', () => {
  test('llama.cpp model_info (meta.n_ctx 262144, args --ctx-size 262144) → 262144', () => {
    expect(
      getModelContextLimitFromInfo({
        model_info: {
          model: 'Ornith-1.5-35B-A3B-Heretic-MTP-APEX-I-Quality',
          tags: [],
          object: 'model',
          owned_by: 'llamacpp',
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          meta: { n_vocab: 248320, n_ctx: 262144, n_ctx_train: 262144, n_params: 35505251456 },
          status: { value: 'loaded', args: ['--ctx-size', '262144', '--jinja'] },
        },
      })
    ).toBe(262144);
  });
  test('no Modelfile/parameters → structured walk still finds meta.n_ctx', () => {
    expect(
      getModelContextLimitFromInfo({
        model_info: {
          meta: { n_ctx: 262144 },
          status: { args: ['--ctx-size', '262144'] },
        },
      })
    ).toBe(262144);
  });
});

describe('parseContextLimitFromError', () => {
  test.each([
    [
      'OpenAI-style 4096 → 4096',
      "This model's maximum context length is 4096 tokens. Please reduce the length of the messages.",
      4096,
    ],
    [
      'OpenAI-style 16385 → 16385',
      "This model's maximum context length is 16385 tokens. Please reduce the length of the messages.",
      16385,
    ],
    ['unrelated error → null', 'Invalid API key', null],
    [
      'Ollama-style error (no "this model\'s" prefix) → null',
      'context length exceeded: 4122 > 4096',
      null,
    ],
  ])('%s', (_label, input, expected) => {
    expect(parseContextLimitFromError(input)).toBe(expected);
  });

  // llama.cpp / llama-server (and llama-swap-style model managers) report the
  // over-budget request in a different shape. This is the exact message that
  // killed the odometer-location sub-agent.
  test.each([
    [
      'llama.cpp "exceeds the available context size (262144 tokens)" → 262144',
      '400 request (326517 tokens) exceeds the available context size (262144 tokens), try increasing it',
      262144,
    ],
    [
      'llama.cpp phrasing without the leading status code → 393216',
      'the request exceeds the available context size (393216 tokens), try increasing it',
      393216,
    ],
    [
      'OpenAI phrasing wins when both phrasings appear',
      "This model's maximum context length is 4096 tokens. request (8192 tokens) exceeds the available context size (2048 tokens)",
      4096,
    ],
    [
      'llama.cpp phrasing without a bracketed count → null',
      'the request exceeds the available context size, try increasing it',
      null,
    ],
  ])('%s', (_label, input, expected) => {
    expect(parseContextLimitFromError(input)).toBe(expected);
  });
});

// ── invalidateCapCache (cache surface, no network) ─────────────────────────

// invalidateCapCache — targeted invalidation
// We exercise the cache through the public invalidation API. Since
// the internal cache Map is module-private, we can only verify
// invalidation by observing that subsequent calls to the public
// API don't throw and the cache surface is consistent.
describe('cache invalidation on an empty cache', () => {
  test('does not throw', () => {
    clearCapCache();
    expect(() => {
      invalidateCapCache();
      invalidateCapCache('http://localhost:11434');
      invalidateCapCache('http://localhost:11434', 'qwen3.6:35b');
    }).not.toThrow();
  });

  test('clearCapCache and invalidateCapCache compose cleanly', () => {
    expect(() => {
      clearCapCache();
      invalidateCapCache('http://anywhere', 'anymodel');
      clearCapCache();
    }).not.toThrow();
  });
});
