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
  createStreamState,
  endRequest,
  isRequestFailed,
  markRequestFailed,
  migrateSessionKey,
  ownerOf,
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

check('ending a turn reports whether it failed', () => {
  let state = beginRequest(createStreamState(), 1, 7);
  state = markRequestFailed(state, 1);
  assert.equal(endRequest(state, 1).failed, true);
});

check('ending a turn that did not fail reports no failure', () => {
  const state = beginRequest(createStreamState(), 1, 7);
  assert.equal(endRequest(state, 1).failed, false);
});

check('the failure flag is gone from the state once the turn is ended', () => {
  // The trap this pins: the flag lives on the request record, so reading it
  // back out of the state after the turn has ended always says "did not
  // fail" — which is how a failed turn lost its retry payload and left the
  // Retry button doing nothing. The flag has to be taken from `endRequest`.
  let state = beginRequest(createStreamState(), 1, 7);
  state = markRequestFailed(state, 1);
  const { state: after, failed } = endRequest(state, 1);
  assert.equal(failed, true);
  assert.equal(isRequestFailed(after, 1), false);
});

// ── no buffering ───────────────────────────────────────────────────────────
check('the machine holds no events, only the turns', () => {
  // Events are applied to their session's slot as they arrive (see
  // scripts/test-chat-store.mjs); a buffer replayed on switch-back duplicated
  // what the database reload already had.
  const state = beginRequest(createStreamState(), 1, 7);
  assert.deepEqual(Object.keys(state), ['requests']);
});

// ── the placeholder migration ──────────────────────────────────────────────
check('a turn on the placeholder follows the session it is saved to', () => {
  let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
  state = migrateSessionKey(state, 7);
  assert.equal(ownerOf(state, 1), 7);
});

check('other sessions are left alone by the migration', () => {
  let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
  state = beginRequest(state, 2, 9);
  state = migrateSessionKey(state, 7);
  assert.equal(ownerOf(state, 2), 9);
});

check('the migration is idempotent', () => {
  let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
  state = migrateSessionKey(state, 7);
  state = migrateSessionKey(state, 7);
  assert.equal(ownerOf(state, 1), 7);
  // One request — the migration must not duplicate it.
  assert.equal(state.requests.size, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
