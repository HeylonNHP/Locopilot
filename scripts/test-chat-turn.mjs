#!/usr/bin/env node
/**
 * Tests for the chat turn transport (src/app/lib/chatTurn.ts).
 *
 * Run with: npx tsx scripts/test-chat-turn.mjs
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

import assert from 'node:assert/strict';

import {
  errorMessageFromResponse,
  retryBodyForSession,
  toSseEventData,
} from '../src/app/lib/chatTurn.ts';

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

check('a JSON message is used as the error', () => {
  assert.equal(
    errorMessageFromResponse(400, JSON.stringify({ message: 'Model name is required' })),
    'HTTP 400: Model name is required'
  );
});

check('the error field is used when there is no message', () => {
  assert.equal(
    errorMessageFromResponse(500, JSON.stringify({ error: 'upstream exploded' })),
    'HTTP 500: upstream exploded'
  );
});

check('the status, detail and title fields are used as fallbacks', () => {
  assert.equal(
    errorMessageFromResponse(502, JSON.stringify({ status: 'bad gateway' })),
    'HTTP 502: bad gateway'
  );
  assert.equal(
    errorMessageFromResponse(502, JSON.stringify({ detail: 'no route' })),
    'HTTP 502: no route'
  );
  assert.equal(
    errorMessageFromResponse(502, JSON.stringify({ title: 'Bad Gateway' })),
    'HTTP 502: Bad Gateway'
  );
});

check('any string value is used when no known field is present', () => {
  assert.equal(
    errorMessageFromResponse(500, JSON.stringify({ code: 7, why: 'because' })),
    'HTTP 500: because'
  );
});

check('an SSE error frame is understood', () => {
  const body = 'event: error\ndata: {"message":"model not found"}\n\n';
  assert.equal(errorMessageFromResponse(404, body), 'HTTP 404: model not found');
});

check('a body that is neither JSON nor SSE falls back to the text', () => {
  assert.equal(
    errorMessageFromResponse(500, 'Internal Server Error'),
    'HTTP 500: Internal Server Error'
  );
});

check('a long body is truncated', () => {
  const body = 'x'.repeat(500);
  const message = errorMessageFromResponse(500, body);
  assert.equal(message.length, 'HTTP 500: '.length + 203);
  assert.ok(message.endsWith('...'));
});

check('a non-object frame becomes a chunk', () => {
  assert.deepEqual(toSseEventData('hello'), { content: 'hello' });
  assert.deepEqual(toSseEventData(42), { content: '42' });
});

check('an object frame is passed through', () => {
  assert.deepEqual(toSseEventData({ content: 'hi', sessionId: 3 }), {
    content: 'hi',
    sessionId: 3,
  });
});

check('an array frame becomes a chunk', () => {
  assert.deepEqual(toSseEventData([1, 2]), { content: '1,2' });
});

// ── the retry payload's session ────────────────────────────────────────────
check('a body without a session is pointed at the session the turn was saved to', () => {
  const body = retryBodyForSession(JSON.stringify({ messages: [], sessionId: null }), 42);
  assert.equal(JSON.parse(body).sessionId, 42);
});

check('a body with no session field at all is given one', () => {
  const body = retryBodyForSession(JSON.stringify({ messages: [] }), 42);
  assert.equal(JSON.parse(body).sessionId, 42);
});

check('the rest of the body is preserved', () => {
  const original = { messages: [{ role: 'user', content: 'hi' }], model: 'm', sessionId: null };
  const body = retryBodyForSession(JSON.stringify(original), 42);
  assert.deepEqual(JSON.parse(body).messages, original.messages);
  assert.equal(JSON.parse(body).model, 'm');
});

check('a body that already names a session is left alone', () => {
  const original = JSON.stringify({ messages: [], sessionId: 7 });
  assert.equal(retryBodyForSession(original, 42), original);
});

check('a body that is not JSON is returned untouched', () => {
  assert.equal(retryBodyForSession('not json at all', 42), 'not json at all');
  assert.equal(retryBodyForSession('[1,2,3]', 42), '[1,2,3]');
  assert.equal(retryBodyForSession('"a string"', 42), '"a string"');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
