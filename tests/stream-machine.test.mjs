/**
 * Tests for the streaming ownership machine (src/app/lib/streamMachine.ts).
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

import { describe, expect, test } from '@jest/globals';

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

describe('starting a turn', () => {
  test('a new turn claims its session', () => {
    const state = beginRequest(createStreamState(), 1, 7);
    expect(ownerOf(state, 1)).toBe(7);
  });
});

describe('finishing a turn', () => {
  test('finishing a turn releases its session', () => {
    const state = beginRequest(createStreamState(), 1, 7);
    const { state: after, sessionKey } = endRequest(state, 1);
    expect(sessionKey).toBe(7);
    expect(ownerOf(after, 1)).toBeUndefined();
  });

  test('finishing a turn does not release a session a newer turn has claimed', () => {
    let state = beginRequest(createStreamState(), 1, 7);
    state = beginRequest(state, 2, 7);
    const { state: after } = endRequest(state, 1);
    expect(ownerOf(after, 2)).toBe(7);
  });

  test('finishing an unknown turn is harmless', () => {
    const state = createStreamState();
    const { state: after, sessionKey } = endRequest(state, 99);
    expect(sessionKey).toBeUndefined();
    expect(after.requests.size).toBe(0);
  });
});

describe('failure', () => {
  test('a turn starts as not failed', () => {
    const state = beginRequest(createStreamState(), 1, 7);
    expect(isRequestFailed(state, 1)).toBe(false);
  });

  test('a failed turn is marked as failed', () => {
    const state = markRequestFailed(beginRequest(createStreamState(), 1, 7), 1);
    expect(isRequestFailed(state, 1)).toBe(true);
  });

  test('marking an unknown turn as failed changes nothing', () => {
    const state = createStreamState();
    expect(isRequestFailed(markRequestFailed(state, 42), 42)).toBe(false);
  });

  test('ending a turn reports whether it failed', () => {
    let state = beginRequest(createStreamState(), 1, 7);
    state = markRequestFailed(state, 1);
    expect(endRequest(state, 1).failed).toBe(true);
  });

  test('ending a turn that did not fail reports no failure', () => {
    const state = beginRequest(createStreamState(), 1, 7);
    expect(endRequest(state, 1).failed).toBe(false);
  });

  test('the failure flag is gone from the state once the turn is ended', () => {
    // The trap this pins: the flag lives on the request record, so reading it
    // back out of the state after the turn has ended always says "did not
    // fail" — which is how a failed turn lost its retry payload and left the
    // Retry button doing nothing. The flag has to be taken from `endRequest`.
    let state = beginRequest(createStreamState(), 1, 7);
    state = markRequestFailed(state, 1);
    const { state: after, failed } = endRequest(state, 1);
    expect(failed).toBe(true);
    expect(isRequestFailed(after, 1)).toBe(false);
  });
});

describe('no buffering', () => {
  test('the machine holds no events, only the turns', () => {
    // Events are applied to their session's slot as they arrive (see
    // tests/chat-store.test.mjs); a buffer replayed on switch-back duplicated
    // what the database reload already had.
    const state = beginRequest(createStreamState(), 1, 7);
    expect(Object.keys(state)).toStrictEqual(['requests']);
  });
});

describe('the placeholder migration', () => {
  test('a turn on the placeholder follows the session it is saved to', () => {
    let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
    state = migrateSessionKey(state, 7);
    expect(ownerOf(state, 1)).toBe(7);
  });

  test('other sessions are left alone by the migration', () => {
    let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
    state = beginRequest(state, 2, 9);
    state = migrateSessionKey(state, 7);
    expect(ownerOf(state, 2)).toBe(9);
  });

  test('the migration is idempotent', () => {
    let state = beginRequest(createStreamState(), 1, PLACEHOLDER);
    state = migrateSessionKey(state, 7);
    state = migrateSessionKey(state, 7);
    expect(ownerOf(state, 1)).toBe(7);
    // One request — the migration must not duplicate it.
    expect(state.requests.size).toBe(1);
  });
});
