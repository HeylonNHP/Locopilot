/**
 * Tests for the SSE frame identity envelope (src/app/api/chat/sseStream.ts).
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

import { expect, test } from '@jest/globals';

import { createSseStream } from '../src/app/api/chat/sseStream.ts';

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

test('every frame carries the stream id, session id and a counter', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: 42 });
  stream.sendEvent('chunk', { content: 'hello' });
  const [frame] = parse(frames);
  expect(frame.event).toBe('chunk');
  expect(frame.data.streamId).toBe('turn-1');
  expect(frame.data.sessionId).toBe(42);
  expect(frame.data.seq).toBe(1);
});

test('the frame counter increases by one per frame', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: 42 });
  stream.sendEvent('chunk', { content: 'a' });
  stream.sendEvent('chunk', { content: 'b' });
  stream.sendEvent('done', {});
  const parsed = parse(frames);
  expect(parsed.map((frame) => frame.data.seq)).toStrictEqual([1, 2, 3]);
});

test('the SSE id line identifies the frame within the turn', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: 42 });
  stream.sendEvent('chunk', { content: 'a' });
  stream.sendEvent('chunk', { content: 'b' });
  const parsed = parse(frames);
  expect(parsed.map((frame) => frame.id)).toStrictEqual(['turn-1:1', 'turn-1:2']);
});

test('a session that does not exist yet is reported as null', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: null });
  stream.sendEvent('chunk', { content: 'a' });
  const [frame] = parse(frames);
  expect(frame.data.sessionId).toBeNull();
});

test('session_created keeps its own session id', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: 7 });
  stream.sendEvent('session_created', { sessionId: 7 });
  const [frame] = parse(frames);
  expect(frame.data.sessionId).toBe(7);
});

test('the identity follows the session once the server assigns one', () => {
  const identity = { streamId: 'turn-1', sessionId: null };
  const { frames, stream } = captureFrames(identity);
  stream.sendEvent('chunk', { content: 'a' });
  identity.sessionId = 7;
  stream.sendEvent('chunk', { content: 'b' });
  const parsed = parse(frames);
  expect(parsed[0].data.sessionId).toBeNull();
  expect(parsed[1].data.sessionId).toBe(7);
});

test('the payload of the event is preserved', () => {
  const { frames, stream } = captureFrames({ streamId: 'turn-1', sessionId: 42 });
  stream.sendEvent('tool_result', { name: 'read_file', result: 'ok', duration: 12 });
  const [frame] = parse(frames);
  expect(frame.data.name).toBe('read_file');
  expect(frame.data.result).toBe('ok');
  expect(frame.data.duration).toBe(12);
});
