#!/usr/bin/env node
/**
 * Tests for the streaming ownership machine (src/app/lib/streamMachine.ts).
 *
 * Run with: npx tsx scripts/test-stream-machine.mjs
 *
 * No network, no server, no React. The machine is pure state, so every rule
 * can be exercised directly.
 *
 * Regression focus: the ownership rules used to be five refs in the chat
 * stream hook, and the rule that moves a brand-new chat from its placeholder
 * key to the session id the server assigned was spread over four separate
 * loops — missing one left a turn attributed to a session that never
 * existed. These tests pin each rule, especially that one.
 */

import assert from 'node:assert/strict';

import {
  beginRequest,
  bufferEvent,
  createStreamState,
  discardBufferedEvents,
  endRequest,
  findBufferedDone,
  isRequestFailed,
  markRequestFailed,
  migrateSessionKey,
  ownerOf,
  takeBufferedEvents,
} from '../src/app/lib/streamMachine.ts';

const PLACEHOLDER = -1;

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

// ── starting a turn ────────────────────────────────────────────────────────
check('a new turn claims its session', () => {
  const state = beginRequest(createStreamState(), 1, 7);
  assert.equal(ownerOf(state, 1), 7);
});

check('a new turn drops whatever was left over from an earlier turn', () => {
  let state = beginRequest(createStreamState(), 1, 7);
  state = bufferEvent(state, 7, 'chunk', { content: 'stale' });
  state = beginRequest(state, 2, 7);
  assert.deepEqual(takeBufferedEvents(state, 7).events, []);
});

// ── finishing a turn ───────────────────────────────────────────────────────
check('finishing a turn releases its session', () => {
  const state = beginRequest(createStreamState(), 1, 7);
  const { state: after, sessionKey } = endRequest(state, 1);
  assert.equal(sessionKey, 7);
  assert.equal(ownerOf(after, 1), undefined);
});

check('finishing a turn does not release a session a newer turn has claimed', () => {
  let state = beginRequest(createStreamState(), 1, 7);
  state = beginRequest(state, 2, 7);
  const { state: after } = endRequest(state, 1);
  assert.equal(ownerOf(after, 2), 7);
});

check('finishing an unknown turn is harmless', () => {
  const state = createStreamState();
  const { state: after, sessionKey } = endRequest(state, 99);
  assert.equal(sessionKey, undefined);
  assert.equal(after.requests.size, 0);
});

// ── failure ────────────────────────────────────────────────────────────────
check('a turn starts as not failed', () => {
  const state = beginRequest(createStreamState(), 1, 7);
  assert.equal(isRequestFailed(state, 1), false);
});

check('a failed turn is marked as failed', () => {
  const state = markRequestFailed(beginRequest(createStreamState(), 1, 7), 1);
  assert.equal(isRequestFailed(state, 1), true);
});

check('marking an unknown turn as failed changes nothing', () => {
  const state = createStreamState();
  assert.equal(isRequestFailed(markRequestFailed(state, 42), 42), false);
});

// ── buffering ──────────────────────────────────────────────────────────────
check('events are held per session', () => {
  let state = createStreamState();
  state = bufferEvent(state, 7, 'chunk', { content: 'a' });
  state = bufferEvent(state, 7, 'chunk', { content: 'b' });
  state = bufferEvent(state, 9, 'chunk', { content: 'c' });
  assert.equal(state.buffers.get(7).length, 2);
  assert.equal(state.buffers.get(9).length, 1);
});

check('taking the buffer leaves nothing behind', () => {
  const state = bufferEvent(createStreamState(), 7, 'chunk', { content: 'a' });
  const { state: after, events } = takeBufferedEvents(state, 7);
  assert.equal(events.length, 1);
  assert.equal(after.buffers.has(7), false);
});

check('taking an empty buffer yields nothing', () => {
  const { events } = takeBufferedEvents(createStreamState(), 7);
  assert.deepEqual(events, []);
});

check('discarding a buffer leaves nothing behind', () => {
  let state = bufferEvent(createStreamState(), 7, 'chunk', { content: 'a' });
  state = discardBufferedEvents(state, 7);
  assert.equal(state.buffers.has(7), false);
});

check('the buffered terminal event is found', () => {
  let state = createStreamState();
  state = bufferEvent(state, 7, 'chunk', { content: 'a' });
  state = bufferEvent(state, 7, 'done', { doneReason: 'stop' });
  const done = findBufferedDone(state, 7);
  assert.equal(done.event, 'done');
  assert.equal(done.data.doneReason, 'stop');
});

check('a session with no buffered terminal event has none', () => {
  const state = bufferEvent(createStreamState(), 7, 'chunk', { content: 'a' });
  assert.equal(findBufferedDone(state, 7), undefined);
});

// ── the placeholder migration ──────────────────────────────────────────────
check('a turn on the placeholder follows the session it is saved to', () => {
  let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
  state = migrateSessionKey(state, 7);
  assert.equal(ownerOf(state, 1), 7);
});

check('buffered events follow the session they are saved to', () => {
  let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
  state = bufferEvent(state, PLACEHOLDER, 'chunk', { content: 'a' });
  state = migrateSessionKey(state, 7);
  assert.equal(state.buffers.has(PLACEHOLDER), false);
  assert.equal(state.buffers.get(7).length, 1);
});

check('the placeholder buffer is merged into the real session buffer', () => {
  let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
  state = bufferEvent(state, 7, 'chunk', { content: 'existing' });
  state = bufferEvent(state, PLACEHOLDER, 'chunk', { content: 'held' });
  state = migrateSessionKey(state, 7);
  const { events } = takeBufferedEvents(state, 7);
  assert.deepEqual(
    events.map((event) => event.data.content),
    ['existing', 'held']
  );
});

check('other sessions are left alone by the migration', () => {
  let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
  state = beginRequest(state, 2, 9);
  state = bufferEvent(state, 9, 'chunk', { content: 'other' });
  state = migrateSessionKey(state, 7);
  assert.equal(ownerOf(state, 2), 9);
  assert.equal(state.buffers.get(9).length, 1);
});

check('the migration is idempotent', () => {
  let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
  state = migrateSessionKey(state, 7);
  state = migrateSessionKey(state, 7);
  assert.equal(ownerOf(state, 1), 7);
  assert.equal(state.owners.size, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
