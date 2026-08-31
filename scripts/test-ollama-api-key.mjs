#!/usr/bin/env node
/**
 * Unit tests for Ollama API key support in the adapter.
 *
 * Run with: npx tsx scripts/test-ollama-api-key.mjs
 *
 * No network, no live server, no Ollama. Mirrors
 * `scripts/test-vision-cache.mjs`: pure imports, assert helpers,
 * PASS/FAIL per case, exit 1 on any failure.
 *
 * Verifies that `buildRequestClient` (which delegates to
 * `buildOllamaClient`) sends `Authorization: Bearer <key>` when a
 * non-empty `ctx.apiKey` is configured, and sends no Authorization
 * header when it is absent or empty — matching the OpenAI-compatible
 * adapter's behaviour (see `openaiCompatibleAdapter.ts:buildAxiosClient`).
 */
import { ollamaAdapter } from '../src/services/adapters/ollamaAdapter.ts';

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

assertEq(getAuthHeader({ baseUrl: BASE_URL }), undefined, 'no apiKey — no Authorization header');

assertEq(
  getAuthHeader({ baseUrl: BASE_URL, apiKey: '' }),
  undefined,
  'empty apiKey — no Authorization header'
);

assertEq(
  getAuthHeader({ baseUrl: BASE_URL, apiKey: 'sk-test-123' }),
  'Bearer sk-test-123',
  'non-empty apiKey — Bearer Authorization header'
);

// Whitespace-only keys are scrubbed upstream by the config route
// (src/app/api/config/route.ts trims before storing), so the adapter
// intentionally matches openaiCompatibleAdapter's `.length > 0` check
// rather than adding its own trim here.

// Shared axios default must not be polluted between contexts.
ollamaAdapter.buildRequestClient({ baseUrl: BASE_URL, apiKey: 'leak-me' });
assertEq(
  getAuthHeader({ baseUrl: BASE_URL }),
  undefined,
  'keyed request does not leak header to subsequent keyless request'
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
