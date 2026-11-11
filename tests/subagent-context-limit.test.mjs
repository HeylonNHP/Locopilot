/**
 * Unit tests for the reactive context-limit recovery clamp
 * (adoptDiscoveredContextLimit in src/tools/impl/subAgentTool.ts).
 *
 * No network, no live server: the function under test is pure mutation of a
 * config object plus the cap resolver's in-process cache (whose hit path
 * short-circuits before any HTTP probe, so the cache assertion below is
 * network-free too).
 *
 * Regression focus: a sub-agent whose LLM call is rejected with a
 * context-limit 400 naming the real cap (e.g. llama-server's "request
 * (326517 tokens) exceeds the available context size (262144 tokens)") must
 * fold that cap into (a) the resolver cache, (b) its own config — including
 * the compaction runtime when that points at the same server+model — and
 * (c) the parent route via the onContextLimitDiscovered hook.
 *
 * Each test prints PASS/FAIL with a one-line label. Exit code is 0 when all
 * pass, 1 otherwise.
 */

import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { clearCapCache } from '../src/services/capResolver.ts';
import { resolveNumCtx } from '../src/services/contextWindow/resolveNumCtx.ts';
import { buildLlmRequestContext } from '../src/services/llm.ts';
import { adoptDiscoveredContextLimit } from '../src/tools/impl/subAgentTool.ts';

const CAP = 262144;
const REQUESTED = 1_000_000;

/**
 * Minimal SubAgentConfig with the same shape the chat route builds for a
 * batch: the main model also serves compaction unless a separate compaction
 * provider was configured.
 */
function makeConfig(overrides = {}) {
  return {
    provider: 'openai-compatible',
    baseUrl: 'http://192.168.1.15:8080',
    model: 'Ornith-1.5-35B-A3B-Heretic-MTP-APEX-I-Quality',
    numCtx: REQUESTED,
    compactionModel: 'Ornith-1.5-35B-A3B-Heretic-MTP-APEX-I-Quality',
    compactionLlmRequestContext: buildLlmRequestContext({
      provider: 'openai-compatible',
      baseUrl: 'http://192.168.1.15:8080',
    }),
    compactionNumCtx: REQUESTED,
    tools: [],
    ...overrides,
  };
}

describe('adoptDiscoveredContextLimit', () => {
  beforeEach(() => {
    clearCapCache();
  });

  test('clamps the main and compaction windows when both use the same runtime', () => {
    const onContextLimitDiscovered = jest.fn();
    const config = makeConfig({ onContextLimitDiscovered });

    adoptDiscoveredContextLimit(config, CAP);

    // 1,000,000 → 262,144
    expect(config.numCtx).toBe(CAP);
    expect(config.compactionNumCtx).toBe(CAP);
    // the route hook is invoked exactly once, with the discovered cap
    expect(onContextLimitDiscovered).toHaveBeenCalledTimes(1);
    expect(onContextLimitDiscovered).toHaveBeenCalledWith(CAP);
  });

  // This is what stops the next 400.
  test('teaches the resolver cache the cap', async () => {
    const config = makeConfig();
    adoptDiscoveredContextLimit(config, CAP);

    const resolved = await resolveNumCtx({
      ctx: buildLlmRequestContext({ provider: 'openai-compatible', baseUrl: config.baseUrl }),
      model: config.model,
      configNumCtx: REQUESTED,
    });

    // a later resolve uses the limit the provider disclosed
    expect(resolved.source).toBe('learned');
    expect(resolved.modelMax).toBe(CAP);
    // clamped to 262,144, not 1,000,000
    expect(resolved.effective).toBe(CAP);
  });

  describe('a compaction runtime that is not the same server and model keeps its own window', () => {
    test('on another server', () => {
      const config = makeConfig({
        compactionLlmRequestContext: buildLlmRequestContext({
          provider: 'openai-compatible',
          baseUrl: 'https://compaction.example.invalid',
        }),
      });
      adoptDiscoveredContextLimit(config, CAP);

      expect(config.numCtx).toBe(CAP);
      expect(config.compactionNumCtx).toBe(REQUESTED);
    });

    test('with another model', () => {
      const config = makeConfig({
        compactionModel: 'some-other-compaction-model',
        compactionLlmRequestContext: undefined,
      });
      adoptDiscoveredContextLimit(config, CAP);

      expect(config.numCtx).toBe(CAP);
      expect(config.compactionNumCtx).toBe(REQUESTED);
    });
  });

  test('an empty compactionModel means "same as main"', () => {
    const config = makeConfig({ compactionModel: '' });
    adoptDiscoveredContextLimit(config, CAP);

    expect(config.compactionNumCtx).toBe(CAP);
  });

  describe('the clamp is a ceiling, never a floor', () => {
    test('a deliberate smaller ceiling is never raised', () => {
      const seen = [];
      const config = makeConfig({
        numCtx: 131072,
        compactionNumCtx: 65536,
        onContextLimitDiscovered: (cap) => seen.push(cap),
      });

      adoptDiscoveredContextLimit(config, CAP);

      expect(config.numCtx).toBe(131072);
      expect(config.compactionNumCtx).toBe(65536);
      // the route hook still learns the model cap for display
      expect(seen[0]).toBe(CAP);
    });

    test('an undefined compactionNumCtx adopts the cap', () => {
      const config = makeConfig({ compactionNumCtx: undefined });
      adoptDiscoveredContextLimit(config, CAP);

      expect(config.compactionNumCtx).toBe(CAP);
    });
  });

  describe('defensive input handling', () => {
    test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'an invalid cap (%p) is ignored',
      (bad) => {
        const onContextLimitDiscovered = jest.fn();
        const config = makeConfig({ onContextLimitDiscovered });

        adoptDiscoveredContextLimit(config, bad);

        expect(config.numCtx).toBe(REQUESTED);
        expect(onContextLimitDiscovered).not.toHaveBeenCalled();
      }
    );

    test('a missing hook is not an error', () => {
      const config = makeConfig({ onContextLimitDiscovered: undefined });

      expect(() => adoptDiscoveredContextLimit(config, CAP)).not.toThrow();
      // clamping still happens without the hook
      expect(config.numCtx).toBe(CAP);
    });
  });
});
