/**
 * Tests for logging the body of an Ollama 400 (src/services/adapters/ollamaAdapter.ts).
 *
 * No network. A fake axios error stands in for the rejection.
 *
 * Why: the OpenAI-compatible path dumps its 400 bodies; the Ollama path logged
 * only the status. A sub-agent's "context window exceeds limit" 400 could not be
 * explained afterwards. These checks pin that a 400 body is logged, that a
 * streamed body is read without losing it for the caller, that other statuses
 * are left alone, and that long bodies are cut.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { debugLog } from '../src/app/lib/debugLogger.ts';
import { logOllamaBadRequest } from '../src/services/adapters/ollamaAdapter.ts';

/** A fake axios error with the given status and response body. */
function axiosError(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.isAxiosError = true;
  error.response = { status, data };
  return error;
}

const ctx = { baseUrl: 'http://localhost:11434', requestId: 'req-test' };

describe('logOllamaBadRequest', () => {
  /** Capture diagnostics instead of writing the log file. */
  let diagnostic;
  const logged = () => diagnostic.mock.calls.map(([entry]) => entry);

  beforeEach(() => {
    diagnostic = jest.spyOn(debugLog, 'diagnostic').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a 400 with a plain-text body is logged with that body', async () => {
    await logOllamaBadRequest(
      axiosError(400, '{"error":"does not support chat"}'),
      ctx,
      'tev1:0.8b'
    );
    expect(logged()).toHaveLength(1);
    expect(logged()[0]).toMatchObject({
      phase: 'error',
      errorStatus: 400,
      errorBody: '{"error":"does not support chat"}',
      model: 'tev1:0.8b',
      requestId: 'req-test',
    });
  });

  test('a streamed 400 body is read, logged, and left as text for the caller', async () => {
    const error = axiosError(
      400,
      Readable.from([
        Buffer.from('{"error":"invalid params, '),
        Buffer.from('context window exceeds limit"}'),
      ])
    );
    await logOllamaBadRequest(error, ctx, 'minimax-m3.1-flash');
    expect(logged()).toHaveLength(1);
    expect(logged()[0].errorBody).toBe('{"error":"invalid params, context window exceeds limit"}');
    // the stream was replaced with text, so the caller can read it again
    expect(error.response.data).toBe('{"error":"invalid params, context window exceeds limit"}');
  });

  test('other statuses are not logged', async () => {
    await logOllamaBadRequest(axiosError(500, 'boom'), ctx, 'm');
    await logOllamaBadRequest(axiosError(404, 'missing'), ctx, 'm');
    expect(diagnostic).not.toHaveBeenCalled();
  });

  test('errors that are not from axios are not logged', async () => {
    await logOllamaBadRequest(new Error('plain failure'), ctx, 'm');
    expect(diagnostic).not.toHaveBeenCalled();
  });

  test('a long body is cut to a preview', async () => {
    await logOllamaBadRequest(axiosError(400, 'x'.repeat(5000)), ctx, 'm');
    expect(logged()[0].errorBody.length).toBeLessThanOrEqual(1001);
    expect(logged()[0].errorBody.endsWith('…')).toBe(true);
  });
});

describe('the Ollama adapter', () => {
  test('both the streaming and the non-streaming request call the 400 logger', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const adapterSource = fs.readFileSync(
      path.join(here, '..', 'src/services/adapters/ollamaAdapter.ts'),
      'utf8'
    );
    const calls = adapterSource.match(/logOllamaBadRequest\(err, ctx, params\.model\)/g) ?? [];
    expect(calls).toHaveLength(2);
  });
});
