#!/usr/bin/env node
/**
 * Tests for the batched dispatcher (src/app/lib/updateBatcher.ts).
 *
 * Run with: npx tsx scripts/test-update-batcher.mjs
 *
 * No network, no server, no React; the clock is fake.
 *
 * Regression focus: every piece of text of a conversation streaming in the
 * background used to be dispatched at once, and every dispatch re-renders the
 * conversation on screen — with 253 messages on screen and two background
 * streams the main thread was blocked about half the time. Background updates
 * are now queued and applied together once per interval. What must hold:
 *
 *   - nothing is applied before the interval, and everything is applied in
 *     order when it elapses;
 *   - the window is FIXED from the first queued update (a stream that never
 *     pauses must still be applied), not a debounce;
 *   - an ordinary dispatch applies the queue FIRST, which is what keeps a
 *     session switch, a reload from the database and a turn's end seeing
 *     everything that arrived.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBatchedDispatcher } from '../src/app/lib/updateBatcher.ts';
import { createFakeClock } from './fakeClock.mjs';

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

const INTERVAL = 1000;

/** A dispatcher over a fake clock, recording what was applied and in which call. */
function setup() {
  const clock = createFakeClock();
  const applied = [];
  const batched = createBatchedDispatcher((action) => applied.push(action), {
    intervalMs: INTERVAL,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { clock, applied, batched };
}

// ── the queue ──────────────────────────────────────────────────────────────
check('nothing is applied before the interval, then everything is, in order', () => {
  const { clock, applied, batched } = setup();
  batched.dispatchBackground('a');
  batched.dispatchBackground('b');
  batched.dispatchBackground('c');
  clock.advance(INTERVAL - 1);
  assert.deepEqual(applied, []);
  clock.advance(1);
  assert.deepEqual(applied, ['a', 'b', 'c']);
});

check('the window is fixed from the first queued update, not a debounce', () => {
  const { clock, applied, batched } = setup();
  batched.dispatchBackground('a');
  clock.advance(900);
  batched.dispatchBackground('b'); // a stream that keeps going must not push the deadline out
  clock.advance(100);
  assert.deepEqual(applied, ['a', 'b']);
});

check('a new window starts after the queue has been applied', () => {
  const { clock, applied, batched } = setup();
  batched.dispatchBackground('a');
  clock.advance(INTERVAL);
  batched.dispatchBackground('b');
  clock.advance(INTERVAL - 1);
  assert.deepEqual(applied, ['a']);
  clock.advance(1);
  assert.deepEqual(applied, ['a', 'b']);
});

check('a stream that never pauses is applied every interval', () => {
  const { clock, applied, batched } = setup();
  for (let tick = 0; tick < 30; tick += 1) {
    batched.dispatchBackground(tick);
    clock.advance(100); // 30 pieces over 3 s
  }
  assert.equal(applied.length, 30, 'three windows of ten, nothing left behind');
});

// ── the ordering rule ──────────────────────────────────────────────────────
check('an ordinary dispatch applies the queue first, in order', () => {
  const { applied, batched } = setup();
  batched.dispatchBackground('a');
  batched.dispatchBackground('b');
  batched.dispatch('now');
  assert.deepEqual(applied, ['a', 'b', 'now']);
});

check('the timer does not apply anything twice after a dispatch flushed the queue', () => {
  const { clock, applied, batched } = setup();
  batched.dispatchBackground('a');
  batched.dispatch('now');
  clock.advance(INTERVAL * 3);
  assert.deepEqual(applied, ['a', 'now']);
  assert.equal(clock.pending(), 0);
});

check('a dispatch with nothing queued is immediate and schedules nothing', () => {
  const { clock, applied, batched } = setup();
  batched.dispatch('now');
  assert.deepEqual(applied, ['now']);
  assert.equal(clock.pending(), 0);
});

// ── flush ──────────────────────────────────────────────────────────────────
check('flush applies the queue now and cancels the timer', () => {
  const { clock, applied, batched } = setup();
  batched.dispatchBackground('a');
  batched.flush();
  assert.deepEqual(applied, ['a']);
  assert.equal(clock.pending(), 0, 'the timer handle is cancelled even though it is 0');
  clock.advance(INTERVAL * 2);
  assert.deepEqual(applied, ['a']);
});

check('flushing an empty queue does nothing', () => {
  const { clock, applied, batched } = setup();
  batched.flush();
  batched.flush();
  assert.deepEqual(applied, []);
  assert.equal(clock.pending(), 0);
});

check('an update queued while a batch is being applied is not lost', () => {
  const clock = createFakeClock();
  const applied = [];
  const batched = createBatchedDispatcher(
    (action) => {
      applied.push(action);
      if (action === 'a') batched.dispatchBackground('queued-during-apply');
    },
    { intervalMs: INTERVAL, schedule: clock.schedule, cancel: clock.cancel }
  );
  batched.dispatchBackground('a');
  batched.dispatchBackground('b');
  clock.advance(INTERVAL);
  assert.deepEqual(applied, ['a', 'b'], 'the batch itself is untouched');
  clock.advance(INTERVAL);
  assert.deepEqual(applied, ['a', 'b', 'queued-during-apply']);
});

// ── the wiring the app must keep ───────────────────────────────────────────
// The provider and the stream hook cannot run without React, so the source is
// read.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) =>
  fs.readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');
const storeSource = read('src/app/lib/chatStore.ts');
const hookSource = read('src/app/hooks/useChatStream.ts');

check('the provider hands out the batched dispatch, never the raw one', () => {
  assert.ok(storeSource.includes('dispatch: batched.dispatch'));
  assert.ok(storeSource.includes('dispatchBackground: batched.dispatchBackground'));
  assert.ok(!storeSource.includes('dispatch: rawDispatch'));
  assert.ok(storeSource.includes('intervalMs: BACKGROUND_UPDATE_INTERVAL_MS'));
});

check('the stream hook applies every routed action through the owner-aware helper', () => {
  assert.ok(hookSource.includes('dispatchOwned(action, owner)'));
  assert.ok(
    !/for \(const action of outcome\.actions\) {\s*dispatch\(/.test(hookSource),
    'a routed action is dispatched directly'
  );
});

check('only the store and the stream hook queue background updates', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.(ts|tsx)$/.test(entry.name) && /dispatchBackground/.test(read(relative))) {
        offenders.push(relative);
      }
    }
  };
  walk('src');
  const allowed = new Set([
    'src/app/lib/chatStore.ts',
    'src/app/lib/updateBatcher.ts',
    'src/app/hooks/useChatStream.ts',
  ]);
  assert.deepEqual(
    offenders.filter((file) => !allowed.has(file)),
    []
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
