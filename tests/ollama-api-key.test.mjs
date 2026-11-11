/**
 * Unit tests for Ollama API key support in the adapter.
 *
 * No network, no live server, no Ollama: pure imports and one adapter call per case.
 *
 * Verifies that `buildRequestClient` (which delegates to
 * `buildOllamaClient`) sends `Authorization: Bearer <key>` when a
 * non-empty `ctx.apiKey` is configured, and sends no Authorization
 * header when it is absent or empty — matching the OpenAI-compatible
 * adapter's behaviour (see `openaiCompatibleAdapter.ts:buildAxiosClient`).
 */
import { expect, test } from '@jest/globals';

import { ollamaAdapter } from '../src/services/adapters/ollamaAdapter.ts';

const BASE_URL = 'http://localhost:11434';

// Intercept the adapter's HTTP layer: buildRequestClient returns an
// AxiosLike; we can spy on its config by making a no-op `get` against a
// mock. Since buildOllamaClient returns either the shared `axios` default
// or a fresh instance with a default header, we probe the header by
// inspecting the instance's `defaults.headers`.
function getAuthHeader(ctx) {
  const client = ollamaAdapter.buildRequestClient(ctx);
  const headers = client?.defaults?.headers ?? {};
  const common = headers.common ?? {};
  const flat =
    headers.Authorization ?? common.Authorization ?? headers.authorization ?? common.authorization;
  return typeof flat === 'function' ? flat() : flat;
}

test.each([
  ['no apiKey — no Authorization header', { baseUrl: BASE_URL }, undefined],
  ['empty apiKey — no Authorization header', { baseUrl: BASE_URL, apiKey: '' }, undefined],
  [
    'non-empty apiKey — Bearer Authorization header',
    { baseUrl: BASE_URL, apiKey: 'sk-test-123' },
    'Bearer sk-test-123',
  ],
])('%s', (_label, input, expected) => {
  expect(getAuthHeader(input)).toBe(expected);
});

// Whitespace-only keys are scrubbed upstream by the config route
// (src/app/api/config/route.ts trims before storing), so the adapter
// intentionally matches openaiCompatibleAdapter's `.length > 0` check
// rather than adding its own trim here.

test('keyed request does not leak its header to a later keyless request', () => {
  // The shared axios default must not be polluted between contexts.
  ollamaAdapter.buildRequestClient({ baseUrl: BASE_URL, apiKey: 'leak-me' });
  expect(getAuthHeader({ baseUrl: BASE_URL })).toBeUndefined();
});
