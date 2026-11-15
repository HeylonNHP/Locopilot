/**
 * Tests for the configurable web-search compaction timeout
 * (`webSearch.requestTimeoutMs`): the per-call timeout for the LLM pass that
 * compacts each fetched web page down to `perPageCharLimit`.
 *
 * Behavioural checks cover the defaults, the value guard that every read site
 * goes through, and the duration-input parser. The remaining checks are
 * source-level wiring checks: the Next.js route handlers cannot be imported
 * into a unit test, so the validation, the chat route, and the client
 * hydration are checked as text.
 */

import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';

import { timeoutPartsToMs } from '@/app/lib/timeoutParts';
import { MAX_CONFIG_TIMEOUT_MS } from '@/constants';
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  defaultWebSearchSettings,
  resolveWebSearchRequestTimeoutMs,
} from '@/services/configDefaults';

const COMPACTION_TIMEOUT_DEFAULT_MS = 60_000; // WEB_COMPACTION_REQUEST_TIMEOUT_MS

const read = (relPath) => readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');

describe('web-search compaction timeout defaults', () => {
  it('bounds user-configured timeouts to 24 hours', () => {
    expect(MAX_CONFIG_TIMEOUT_MS).toBe(86_400_000);
  });

  it('defaults to the 60-second compaction timeout', () => {
    expect(DEFAULT_WEB_SEARCH_SETTINGS.requestTimeoutMs).toBe(COMPACTION_TIMEOUT_DEFAULT_MS);
    expect(defaultWebSearchSettings().requestTimeoutMs).toBe(COMPACTION_TIMEOUT_DEFAULT_MS);
  });

  it('returns a copy, so mutating it cannot change the shared default', () => {
    const copy = defaultWebSearchSettings();
    copy.requestTimeoutMs = 1;
    expect(DEFAULT_WEB_SEARCH_SETTINGS.requestTimeoutMs).toBe(COMPACTION_TIMEOUT_DEFAULT_MS);
  });
});

describe('resolveWebSearchRequestTimeoutMs', () => {
  it('keeps usable values: positive integers up to the 24-hour bound', () => {
    expect(resolveWebSearchRequestTimeoutMs(1)).toBe(1);
    expect(resolveWebSearchRequestTimeoutMs(900_000)).toBe(900_000);
    expect(resolveWebSearchRequestTimeoutMs(MAX_CONFIG_TIMEOUT_MS)).toBe(MAX_CONFIG_TIMEOUT_MS);
  });

  it.each([
    ['zero', 0],
    ['negative', -5_000],
    ['fractional', 1.5],
    ['over the 24-hour bound', MAX_CONFIG_TIMEOUT_MS + 1],
    ['a numeric string', '900000'],
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('falls back to the default for %s', (_label, value) => {
    expect(resolveWebSearchRequestTimeoutMs(value)).toBe(COMPACTION_TIMEOUT_DEFAULT_MS);
  });
});

describe('timeoutPartsToMs (Settings duration inputs)', () => {
  it('converts hours, minutes and seconds to milliseconds', () => {
    expect(timeoutPartsToMs('1', '2', '3')).toBe(3_723_000);
    expect(timeoutPartsToMs('0', '1', '0')).toBe(60_000);
  });

  it('treats empty and unparseable parts as zero', () => {
    expect(timeoutPartsToMs('', '', '')).toBe(0);
    expect(timeoutPartsToMs('abc', '5', '')).toBe(300_000);
  });

  it('clamps negative parts so they cannot cancel other parts', () => {
    // Without clamping, hours -1 with minutes 90 would sum to 30 minutes.
    expect(timeoutPartsToMs('-1', '90', '0')).toBe(5_400_000);
    expect(timeoutPartsToMs('0', '-10', '-30')).toBe(0);
  });
});

describe('config route wiring', () => {
  it('accepts requestTimeoutMs as a known webSearch key and validates it', async () => {
    const src = await read('src/app/api/config/route.ts');
    expect(src).toContain("'requestTimeoutMs',\n]);");
    expect(src).toContain("if ('requestTimeoutMs' in input.webSearch)");
    expect(src).toContain('v <= 0 || v > MAX_CONFIG_TIMEOUT_MS');
  });

  it('starts the PUT block empty so omitted keys are not reset to defaults', async () => {
    const src = await read('src/app/api/config/route.ts');
    expect(src).toContain('const webSearch: Partial<WebSearchSettingsShape> = {};');
    expect(src).not.toContain(
      'const webSearch: Required<WebSearchSettingsShape> = defaultWebSearchSettings();'
    );
  });

  it('re-checks the merged timeout, so a hand-edited stored value is not kept', async () => {
    const src = await read('src/app/api/config/route.ts');
    expect(src).toMatch(
      /updatedWebSearch\.requestTimeoutMs = resolveWebSearchRequestTimeoutMs\(\s*updatedWebSearch\.requestTimeoutMs\s*\)/
    );
  });
});

describe('chat route wiring', () => {
  it('reads requestTimeoutMs from config through the value guard', async () => {
    const src = await read('src/app/api/chat/route.ts');
    expect(src).toMatch(
      /requestTimeoutMs:\s*resolveWebSearchRequestTimeoutMs\(\s*config\?\.webSearch\?\.requestTimeoutMs\s*\)/
    );
    expect(src).not.toMatch(/requestTimeoutMs:\s*DEFAULT_OLLAMA_CHAT_TIMEOUT_MS/);
  });
});

describe('Settings modal', () => {
  it('shows the compaction timeout and sends it in the PUT body and local update', async () => {
    const src = await read('src/components/SettingsModal/SettingsModal.tsx');
    expect(src).toContain('Web Search: Compaction Timeout');
    const occurrences = src.split('requestTimeoutMs: parsedWebRequestTimeoutMs').length - 1;
    expect(occurrences).toBe(2);
    expect(src).toContain('DEFAULT_WEB_SEARCH_REQUEST_TIMEOUT_MS');
  });

  it('parses the duration inputs with the clamping helper', async () => {
    const src = await read('src/components/SettingsModal/SettingsModal.tsx');
    expect(src).toContain(
      'timeoutPartsToMs(webTimeoutHours, webTimeoutMinutes, webTimeoutSeconds)'
    );
  });
});

describe('client config hydration', () => {
  it('fills missing values from defaults and checks the timeout', async () => {
    const src = await read('src/app/hooks/useDataLoaders.ts');
    expect(src).toContain('...DEFAULT_WEB_SEARCH_SETTINGS,');
    expect(src).toMatch(
      /requestTimeoutMs:\s*resolveWebSearchRequestTimeoutMs\(\s*config\.webSearch\.requestTimeoutMs\s*\)/
    );
  });
});

describe('web-page compaction call', () => {
  it('passes the configured timeout into the compactor instead of the fixed default', async () => {
    const src = await read('src/tools/web/htmlExtractor.ts');
    expect(src).toMatch(
      /ContentCompactor\.create\(\s*settings,\s*compactorContext,\s*{\s*requestTimeoutMs: settings\.requestTimeoutMs,?\s*}\s*\)/
    );
  });
});
