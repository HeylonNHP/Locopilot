/**
 * Tests for the chat turn transport (src/app/lib/chatTurn.ts).
 *
 * No network: the error-message extraction is what is worth pinning, because
 * it decides what the user reads when a turn is refused.
 *
 * Regression focus: sending a message and retrying a failed one each had
 * their own copy of this parsing, and the two copies disagreed — the retry
 * path looked at `message` and `error` only, so a server that reported the
 * problem in `title` or `detail` produced a raw body dump instead of a
 * sentence. One implementation now serves both.
 */

import { describe, expect, test } from '@jest/globals';

import {
  errorMessageFromResponse,
  retryBodyForSession,
  toSseEventData,
} from '../src/app/lib/chatTurn.ts';

test('a JSON message is used as the error', () => {
  expect(errorMessageFromResponse(400, JSON.stringify({ message: 'Model name is required' }))).toBe(
    'HTTP 400: Model name is required'
  );
});

test('the error field is used when there is no message', () => {
  expect(errorMessageFromResponse(500, JSON.stringify({ error: 'upstream exploded' }))).toBe(
    'HTTP 500: upstream exploded'
  );
});

test('the status, detail and title fields are used as fallbacks', () => {
  expect(errorMessageFromResponse(502, JSON.stringify({ status: 'bad gateway' }))).toBe(
    'HTTP 502: bad gateway'
  );
  expect(errorMessageFromResponse(502, JSON.stringify({ detail: 'no route' }))).toBe(
    'HTTP 502: no route'
  );
  expect(errorMessageFromResponse(502, JSON.stringify({ title: 'Bad Gateway' }))).toBe(
    'HTTP 502: Bad Gateway'
  );
});

test('any string value is used when no known field is present', () => {
  expect(errorMessageFromResponse(500, JSON.stringify({ code: 7, why: 'because' }))).toBe(
    'HTTP 500: because'
  );
});

test('an SSE error frame is understood', () => {
  const body = 'event: error\ndata: {"message":"model not found"}\n\n';
  expect(errorMessageFromResponse(404, body)).toBe('HTTP 404: model not found');
});

test('a body that is neither JSON nor SSE falls back to the text', () => {
  expect(errorMessageFromResponse(500, 'Internal Server Error')).toBe(
    'HTTP 500: Internal Server Error'
  );
});

test('a long body is truncated', () => {
  const body = 'x'.repeat(500);
  const message = errorMessageFromResponse(500, body);
  expect(message).toHaveLength('HTTP 500: '.length + 203);
  expect(message.endsWith('...')).toBeTruthy();
});

test('a non-object frame becomes a chunk', () => {
  expect(toSseEventData('hello')).toStrictEqual({ content: 'hello' });
  expect(toSseEventData(42)).toStrictEqual({ content: '42' });
});

test('an object frame is passed through', () => {
  expect(toSseEventData({ content: 'hi', sessionId: 3 })).toStrictEqual({
    content: 'hi',
    sessionId: 3,
  });
});

test('an array frame becomes a chunk', () => {
  expect(toSseEventData([1, 2])).toStrictEqual({ content: '1,2' });
});

describe("the retry payload's session", () => {
  test('a body without a session is pointed at the session the turn was saved to', () => {
    const body = retryBodyForSession(JSON.stringify({ messages: [], sessionId: null }), 42);
    expect(JSON.parse(body).sessionId).toBe(42);
  });

  test('a body with no session field at all is given one', () => {
    const body = retryBodyForSession(JSON.stringify({ messages: [] }), 42);
    expect(JSON.parse(body).sessionId).toBe(42);
  });

  test('the rest of the body is preserved', () => {
    const original = { messages: [{ role: 'user', content: 'hi' }], model: 'm', sessionId: null };
    const body = retryBodyForSession(JSON.stringify(original), 42);
    expect(JSON.parse(body).messages).toStrictEqual(original.messages);
    expect(JSON.parse(body).model).toBe('m');
  });

  test('a body that already names a session is left alone', () => {
    const original = JSON.stringify({ messages: [], sessionId: 7 });
    expect(retryBodyForSession(original, 42)).toBe(original);
  });

  test('a body that is not JSON is returned untouched', () => {
    expect(retryBodyForSession('not json at all', 42)).toBe('not json at all');
    expect(retryBodyForSession('[1,2,3]', 42)).toBe('[1,2,3]');
    expect(retryBodyForSession('"a string"', 42)).toBe('"a string"');
  });
});
