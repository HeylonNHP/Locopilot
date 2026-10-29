#!/usr/bin/env node
/**
 * Tests for the SSE frame identity envelope (src/app/api/chat/sseStream.ts).
 *
 * Run with: npx tsx scripts/test-sse-frame-identity.mjs
 *
 * No network and no server: a ReadableStream controller is enough to capture
 * the frames the emitter writes.
 *
 * Regression focus: the client used to infer which session a frame belonged
 * to from its own bookkeeping, and got it wrong often enough to ship two bug
 * fixes. The server already knows, so every frame now carries the turn id,
 * the session id and a frame counter. These tests pin that contract:
 * the identity is on every frame, the counter only moves forward, and an
 * event's own fields are never clobbered by the envelope.
 */

import assert from 'node:assert/strict';

import { createSseStream } from '../src/app/api/chat/sseStream.ts';

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

/** Collect the frames an emitter writes. */
function captureFrames(identity) {
  const frames = [];
  const controller = {
    enqueue(chunk) {
      frames.push(new TextDecoder().decode(chunk));
    },
  };
  const stream = createSseStream(controller, () => identity);
  return { frames, stream };
}

/** Parse the frames into their event name and payload. */
function parse(frames) {
  return frames.map((frame) => {
    const lines = frame.trim().split('\n');
    const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
    const id = lines.find((line) => line.startsWith('id: '))?.slice('id: '.length);
    const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length);
    return { event, id, data: JSON.parse(data) };
  });
}

check('every frame carries the stream id, session id and a counter', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: 42 });
  stream.sendEvent('chunk', { content: 'hello' });
  const [frame] = parse(frames);
  assert.equal(frame.event, 'chunk');
  assert.equal(frame.data.streamId, 'turn-1');
  assert.equal(frame.data.sessionId, 42);
  assert.equal(frame.data.seq, 1);
});

check('the frame counter increases by one per frame', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: 42 });
  stream.sendEvent('chunk', { content: 'a' });
  stream.sendEvent('chunk', { content: 'b' });
  stream.sendEvent('done', {});
  const parsed = parse(frames);
  assert.deepEqual(
    parsed.map((frame) => frame.data.seq),
    [1, 2, 3]
  );
});

check('the SSE id line identifies the frame within the turn', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: 42 });
  stream.sendEvent('chunk', { content: 'a' });
  stream.sendEvent('chunk', { content: 'b' });
  const parsed = parse(frames);
  assert.deepEqual(
    parsed.map((frame) => frame.id),
    ['turn-1:1', 'turn-1:2']
  );
});

check('a session that does not exist yet is reported as null', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: null });
  stream.sendEvent('chunk', { content: 'a' });
  const [frame] = parse(frames);
  assert.equal(frame.data.sessionId, null);
});

check('session_created keeps its own session id', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: 7 });
  stream.sendEvent('session_created', { sessionId: 7 });
  const [frame] = parse(frames);
  assert.equal(frame.data.sessionId, 7);
});

check('the identity follows the session once the server assigns one', () => {
  const identity = { streamId: 'turn-1', sessionId: null };
  const { frames, stream } = captureFrames(identity);
  stream.sendEvent('chunk', { content: 'a' });
  identity.sessionId = 7;
  stream.sendEvent('chunk', { content: 'b' });
  const parsed = parse(frames);
  assert.equal(parsed[0].data.sessionId, null);
  assert.equal(parsed[1].data.sessionId, 7);
});

check('the payload of the event is preserved', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: 42 });
  stream.sendEvent('tool_result', { name: 'read_file', result: 'ok', duration: 12 });
  const [frame] = parse(frames);
  assert.equal(frame.data.name, 'read_file');
  assert.equal(frame.data.result, 'ok');
  assert.equal(frame.data.duration, 12);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
