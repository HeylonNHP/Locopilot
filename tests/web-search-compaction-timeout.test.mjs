/**
 * Tests for the configurable web-search compaction timeout
 * (`webSearch.requestTimeoutMs`): the per-call timeout for the LLM pass that
 * compacts each fetched web page down to `perPageCharLimit`.
 *
 * Behavioural checks cover the defaults and the shared-object guarantee.
 * The remaining checks are source-level wiring checks: the Next.js route
 * handlers cannot be imported into a unit test, so the validation, the chat
 * route, and the Settings save payloads are checked as text.
 */

import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';

import { MAX_CONFIG_TIMEOUT_MS } from '@/constants';
import { DEFAULT_WEB_SEARCH_SETTINGS, defaultWebSearchSettings } from '@/services/configDefaults';

const CHAT_TIMEOUT_DEFAULT_MS = 720_000; // DEFAULT_OLLAMA_CHAT_TIMEOUT_MS

const read = (relPath) => readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');

describe('web-search compaction timeout defaults', () => {
  it('bounds user-configured timeouts to 24 hours', () => {
    expect(MAX_CONFIG_TIMEOUT_MS).toBe(86_400_000);
  });

  it('defaults to the 12-minute chat timeout', () => {
    expect(DEFAULT_WEB_SEARCH_SETTINGS.requestTimeoutMs).toBe(CHAT_TIMEOUT_DEFAULT_MS);
    expect(defaultWebSearchSettings().requestTimeoutMs).toBe(CHAT_TIMEOUT_DEFAULT_MS);
  });

  it('returns a copy, so mutating it cannot change the shared default', () => {
    const copy = defaultWebSearchSettings();
    copy.requestTimeoutMs = 1;
    expect(DEFAULT_WEB_SEARCH_SETTINGS.requestTimeoutMs).toBe(CHAT_TIMEOUT_DEFAULT_MS);
  });
});

describe('config route wiring', () => {
  it('accepts requestTimeoutMs as a known webSearch key and validates it', async () => {
    const src = await read('src/app/api/config/route.ts');
    expect(src).toContain("'requestTimeoutMs',\n]);");
    expect(src).toContain("if ('requestTimeoutMs' in input.webSearch)");
    expect(src).toContain('v <= 0 || v > MAX_CONFIG_TIMEOUT_MS');
  });

  it('builds the webSearch block from defaults so omitted keys are filled in', async () => {
    const src = await read('src/app/api/config/route.ts');
    expect(src).toContain('defaultWebSearchSettings()');
  });
});

describe('chat route wiring', () => {
  it('reads requestTimeoutMs from config with the default fallback', async () => {
    const src = await read('src/app/api/chat/route.ts');
    expect(src).toContain(
      'config?.webSearch?.requestTimeoutMs ?? DEFAULT_WEB_SEARCH_REQUEST_TIMEOUT_MS'
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
});

describe('client config hydration', () => {
  it('merges loaded webSearch over defaults so requestTimeoutMs is never undefined', async () => {
    const src = await read('src/app/hooks/useDataLoaders.ts');
    expect(src).toContain('{ ...DEFAULT_WEB_SEARCH_SETTINGS, ...config.webSearch }');
  });
});
