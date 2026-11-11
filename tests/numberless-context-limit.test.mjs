/**
 * Tests for a provider's context-limit 400 that names no number (Phase 3.2).
 *
 * No network. The classifier is pure; the two retry branches (the main chat
 * loop and the sub-agent) are pinned in source, because they need a live model
 * to run end to end. The live check is recorded in CONFIRMATIONS C-005.
 *
 * NEEDS CLARIFICATION: only one phrasing is confirmed (Ollama Cloud
 * `minimax-m3.1-flash`). Widen the list in llmContextLimit.ts only from a logged
 * occurrence, and add a case here when you do.
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyContextLimitError,
  isNumberlessContextLimitError,
  parseContextLimitFromError,
} from '../src/services/llmContextLimit.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, '..', relative), 'utf8');

// The exact body the owner's sub-agent received (CONFIRMATIONS C-005).
const NUMBERLESS = '{"error":"invalid params, context window exceeds limit"}';

describe('the numberless phrasing is recognised', () => {
  test('the confirmed Ollama Cloud body is numberless', () => {
    expect(isNumberlessContextLimitError(NUMBERLESS)).toBe(true);
  });

  // The exact text `gpt-oss:20b` on Ollama Cloud returned for a prompt about 5%
  // over its 131,072-token window (CONFIRMATIONS A-007, 2026-11-11). The number is
  // how far OVER the request was, not the size of the window.
  const OVER_BY =
    'Request failed with status code 400: prompt too long; exceeded max context length by 8397 tokens (ref: 9a22efc0-bc25-4041-a572-70a5a0dc827a)';

  test('the gpt-oss:20b body is numberless too, and its number is not taken for the window', () => {
    expect(isNumberlessContextLimitError(OVER_BY)).toBe(true);
    expect(parseContextLimitFromError(OVER_BY)).toBeNull();
    expect(classifyContextLimitError(OVER_BY)).toStrictEqual({ kind: 'compact-only' });
  });

  test.each([
    'prompt too long',
    'prompt too long; try a shorter title',
    'path too long; exceeded max path length by 12 characters',
  ])(
    '"prompt too long" alone, or a path that is too long, is not a context-limit error (%p)',
    (message) => {
      expect(isNumberlessContextLimitError(message)).toBe(false);
    }
  );

  test('the phrase is matched without regard to case or spacing', () => {
    expect(isNumberlessContextLimitError('Invalid Params,  Context Window Exceeds Limit')).toBe(
      true
    );
    expect(isNumberlessContextLimitError('invalid params context window exceeds limit')).toBe(true);
  });

  test('a message that names a window is not numberless (the parser handles it)', () => {
    expect(
      isNumberlessContextLimitError(
        'request (326517 tokens) exceeds the available context size (262144 tokens)'
      )
    ).toBe(false);
  });

  test.each([
    '',
    'Invalid API key',
    'invalid params: temperature must be a number',
    'context window is fine',
    'rate limit exceeded',
  ])('unrelated errors are not numberless (%p)', (message) => {
    expect(isNumberlessContextLimitError(message)).toBe(false);
  });

  test('a non-string or empty message is not numberless', () => {
    expect(isNumberlessContextLimitError(undefined)).toBe(false);
    expect(isNumberlessContextLimitError(null)).toBe(false);
  });
});

describe('the classifier gives each case one verdict', () => {
  test('a message that names the window teaches it (learn)', () => {
    expect(classifyContextLimitError('maximum context length is 4096 tokens')).toStrictEqual({
      kind: 'learn',
      cap: 4096,
    });
  });

  test('the numberless message compacts without learning a cap (compact-only)', () => {
    expect(classifyContextLimitError(NUMBERLESS)).toStrictEqual({ kind: 'compact-only' });
  });

  test('anything else is left to the caller (none)', () => {
    expect(classifyContextLimitError('Invalid API key')).toStrictEqual({ kind: 'none' });
    expect(classifyContextLimitError('')).toStrictEqual({ kind: 'none' });
  });

  test('a message with both a number and the numberless phrase learns the number', () => {
    const both = `${NUMBERLESS} maximum context length is 8192 tokens`;
    expect(classifyContextLimitError(both).kind).toBe('learn');
    expect(parseContextLimitFromError(both)).toBe(8192);
  });
});

describe('the two retry branches use the classifier, and only learn from a number', () => {
  test('the sub-agent branch compacts on either verdict but learns only from a number', () => {
    const source = read('src/tools/impl/subAgentTool.ts');
    expect(source).toContain('classifyContextLimitError(apiMessage)');
    expect(source).toContain("verdict.kind !== 'none'");
    expect(source).toMatch(
      /if \(verdict\.kind === 'learn'\) {\s*adoptDiscoveredContextLimit\(config, verdict\.cap\);/
    );
  });

  test('the main loop retries a numberless 400 once, by compacting and continuing the outer loop', () => {
    const source = read('src/app/api/chat/route.ts');
    expect(source).toContain('classifyContextLimitError(providerMessage)');
    expect(source).toContain("kind === 'compact-only'");
    expect(source).toContain('providerLimitRetriedThisTurn = true;');
    expect(source).toContain('compactionForcedByProvider = true;');
    expect(source).toMatch(/compactionForcedByProvider = true;[\S\s]*?continue outer;/);
    expect(source).toContain('(forcedByProvider || tokensUsed >= compactionTriggerTokens)');
  });

  test('the main loop never learns a cap from a numberless 400', () => {
    const source = read('src/app/api/chat/route.ts');
    const block = new Set(
      source.slice(
        source.indexOf('if (classifyContextLimitError(providerMessage).kind'),
        source.indexOf(
          'continue outer;',
          source.indexOf('if (classifyContextLimitError(providerMessage).kind')
        )
      )
    );
    expect(block.has('adoptDiscoveredContextLimit')).toBeFalsy();
    expect(block.has('recordDiscoveredCap')).toBeFalsy();
  });

  test.each([
    'src/services/llmContextLimit.ts',
    'src/tools/impl/subAgentTool.ts',
    'src/app/api/chat/route.ts',
  ])('the clarification is marked where the phrasing is kept and where it is used (%p)', (file) => {
    expect(read(file)).toContain('NEEDS CLARIFICATION');
  });
});
