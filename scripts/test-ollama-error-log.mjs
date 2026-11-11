#!/usr/bin/env node
/**
 * Tests for logging the body of an Ollama 400 (src/services/adapters/ollamaAdapter.ts).
 *
 * Run with: npx tsx scripts/test-ollama-error-log.mjs
 *
 * No network. A fake axios error stands in for the rejection.
 *
 * Why: the OpenAI-compatible path dumps its 400 bodies; the Ollama path logged
 * only the status. A sub-agent's "context window exceeds limit" 400 could not be
 * explained afterwards. These checks pin that a 400 body is logged, that a
 * streamed body is read without losing it for the caller, that other statuses
 * are left alone, and that long bodies are cut.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { debugLog } from '../src/app/lib/debugLogger.ts';
import { logOllamaBadRequest } from '../src/services/adapters/ollamaAdapter.ts';

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message.split('\n').join('\n        ')}`);
    fail += 1;
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${label}\n        ${err.message.split('\n').join('\n        ')}`);
    fail += 1;
  }
}

/** A fake axios error with the given status and response body. */
function axiosError(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.isAxiosError = true;
  error.response = { status, data };
  return error;
}

const ctx = { baseUrl: 'http://localhost:11434', requestId: 'req-test' };

/** Capture diagnostics instead of writing the log file. */
const captured = [];
const realDiagnostic = debugLog.diagnostic;
debugLog.diagnostic = (entry) => captured.push(entry);

await checkAsync('a 400 with a plain-text body is logged with that body', async () => {
  captured.length = 0;
  await logOllamaBadRequest(axiosError(400, '{"error":"does not support chat"}'), ctx, 'tev1:0.8b');
  assert.equal(captured.length, 1, 'nothing was logged');
  assert.equal(captured[0].phase, 'error');
  assert.equal(captured[0].errorStatus, 400);
  assert.equal(captured[0].errorBody, '{"error":"does not support chat"}');
  assert.equal(captured[0].model, 'tev1:0.8b');
  assert.equal(captured[0].requestId, 'req-test');
});

await checkAsync(
  'a streamed 400 body is read, logged, and left as text for the caller',
  async () => {
    captured.length = 0;
    const error = axiosError(
      400,
      Readable.from([
        Buffer.from('{"error":"invalid params, '),
        Buffer.from('context window exceeds limit"}'),
      ])
    );
    await logOllamaBadRequest(error, ctx, 'minimax-m3.1-flash');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].errorBody, '{"error":"invalid params, context window exceeds limit"}');
    assert.equal(typeof error.response.data, 'string', 'the stream was not replaced with text');
    assert.equal(error.response.data, '{"error":"invalid params, context window exceeds limit"}');
  }
);

await checkAsync('other statuses are not logged', async () => {
  captured.length = 0;
  await logOllamaBadRequest(axiosError(500, 'boom'), ctx, 'm');
  await logOllamaBadRequest(axiosError(404, 'missing'), ctx, 'm');
  assert.equal(captured.length, 0);
});

await checkAsync('errors that are not from axios are not logged', async () => {
  captured.length = 0;
  await logOllamaBadRequest(new Error('plain failure'), ctx, 'm');
  assert.equal(captured.length, 0);
});

await checkAsync('a long body is cut to a preview', async () => {
  captured.length = 0;
  await logOllamaBadRequest(axiosError(400, 'x'.repeat(5000)), ctx, 'm');
  assert.ok(
    captured[0].errorBody.length <= 1001,
    `preview is ${captured[0].errorBody.length} characters`
  );
  assert.ok(captured[0].errorBody.endsWith('…'));
});

debugLog.diagnostic = realDiagnostic;

// The two request paths must both call the helper.
const here = path.dirname(fileURLToPath(import.meta.url));
const adapterSource = fs.readFileSync(
  path.join(here, '..', 'src/services/adapters/ollamaAdapter.ts'),
  'utf8'
);
check('both the streaming and the non-streaming request call the 400 logger', () => {
  const calls = adapterSource.match(/logOllamaBadRequest\(err, ctx, params\.model\)/g) ?? [];
  assert.equal(calls.length, 2, `found ${calls.length} call sites`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
