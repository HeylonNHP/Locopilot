/**
 * Tests for the batched dispatcher (src/app/lib/updateBatcher.ts).
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

import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBatchedDispatcher } from '../src/app/lib/updateBatcher.ts';
import { createFakeClock } from './helpers/fakeClock.mjs';

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

describe('the queue', () => {
  test('nothing is applied before the interval, then everything is, in order', () => {
    const { clock, applied, batched } = setup();
    batched.dispatchBackground('a');
    batched.dispatchBackground('b');
    batched.dispatchBackground('c');
    clock.advance(INTERVAL - 1);
    expect(applied).toStrictEqual([]);
    clock.advance(1);
    expect(applied).toStrictEqual(['a', 'b', 'c']);
  });

  test('the window is fixed from the first queued update, not a debounce', () => {
    const { clock, applied, batched } = setup();
    batched.dispatchBackground('a');
    clock.advance(900);
    batched.dispatchBackground('b'); // a stream that keeps going must not push the deadline out
    clock.advance(100);
    expect(applied).toStrictEqual(['a', 'b']);
  });

  test('a new window starts after the queue has been applied', () => {
    const { clock, applied, batched } = setup();
    batched.dispatchBackground('a');
    clock.advance(INTERVAL);
    batched.dispatchBackground('b');
    clock.advance(INTERVAL - 1);
    expect(applied).toStrictEqual(['a']);
    clock.advance(1);
    expect(applied).toStrictEqual(['a', 'b']);
  });

  test('a stream that never pauses is applied every interval', () => {
    const { clock, applied, batched } = setup();
    for (let tick = 0; tick < 30; tick += 1) {
      batched.dispatchBackground(tick);
      clock.advance(100); // 30 pieces over 3 s
    }
    expect(applied).toHaveLength(30);
  });
});

describe('the ordering rule', () => {
  test('an ordinary dispatch applies the queue first, in order', () => {
    const { applied, batched } = setup();
    batched.dispatchBackground('a');
    batched.dispatchBackground('b');
    batched.dispatch('now');
    expect(applied).toStrictEqual(['a', 'b', 'now']);
  });

  test('the timer does not apply anything twice after a dispatch flushed the queue', () => {
    const { clock, applied, batched } = setup();
    batched.dispatchBackground('a');
    batched.dispatch('now');
    clock.advance(INTERVAL * 3);
    expect(applied).toStrictEqual(['a', 'now']);
    expect(clock.pending()).toBe(0);
  });

  test('a dispatch with nothing queued is immediate and schedules nothing', () => {
    const { clock, applied, batched } = setup();
    batched.dispatch('now');
    expect(applied).toStrictEqual(['now']);
    expect(clock.pending()).toBe(0);
  });
});

describe('flush', () => {
  test('flush applies the queue now and cancels the timer', () => {
    const { clock, applied, batched } = setup();
    batched.dispatchBackground('a');
    batched.flush();
    expect(applied).toStrictEqual(['a']);
    expect(clock.pending()).toBe(0);
    clock.advance(INTERVAL * 2);
    expect(applied).toStrictEqual(['a']);
  });

  test('flushing an empty queue does nothing', () => {
    const { clock, applied, batched } = setup();
    batched.flush();
    batched.flush();
    expect(applied).toStrictEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test('an update queued while a batch is being applied is not lost', () => {
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
    expect(applied).toStrictEqual(['a', 'b']);
    clock.advance(INTERVAL);
    expect(applied).toStrictEqual(['a', 'b', 'queued-during-apply']);
  });
});

describe('the wiring the app must keep', () => {
  // The provider and the stream hook cannot run without React, so the source is
  // read.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (relative) =>
    fs.readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');
  const storeSource = read('src/app/lib/chatStore.ts');
  const hookSource = read('src/app/hooks/useChatStream.ts');

  test('the provider hands out the batched dispatch, never the raw one', () => {
    expect(storeSource).toContain('dispatch: batched.dispatch');
    expect(storeSource).toContain('dispatchBackground: batched.dispatchBackground');
    expect(storeSource).not.toContain('dispatch: rawDispatch');
    expect(storeSource).toContain('intervalMs: BACKGROUND_UPDATE_INTERVAL_MS');
  });

  test('the stream hook applies every routed action through the owner-aware helper', () => {
    expect(hookSource).toContain('dispatchOwned(action, owner)');
    expect(hookSource).not.toMatch(/for \(const action of outcome\.actions\) {\s*dispatch\(/);
  });

  test('only the store and the stream hook queue background updates', () => {
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
    expect(offenders.filter((file) => !allowed.has(file))).toStrictEqual([]);
  });
});
