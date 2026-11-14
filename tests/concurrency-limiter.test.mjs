/**
 * Tests for `ConcurrencyLimiter` (src/util/concurrencyLimiter.ts), the
 * semaphore behind the web search's page, search and compaction caps.
 *
 * No network, no timers beyond `setImmediate`.
 */

import { describe, expect, test } from '@jest/globals';

import { ConcurrencyLimiter } from '../src/util/concurrencyLimiter.ts';

/** A task that stays running until `finish()` is called. */
function controllableTask() {
  let finish;
  let started = false;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  return {
    task: async () => {
      started = true;
      await done;
      return 'ok';
    },
    finish: () => finish(),
    get started() {
      return started;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('ConcurrencyLimiter', () => {
  test.each([0, -1, 1.5, Number.NaN])('rejects a limit of %p', (limit) => {
    expect(() => new ConcurrencyLimiter(limit)).toThrow(RangeError);
  });

  test('never runs more than the limit at once, and runs every task', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let inFlight = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        limiter.run(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await tick();
          inFlight -= 1;
          return i;
        })
      )
    );
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(limiter.running).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  test('starts waiting tasks in arrival order', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order = [];
    const first = controllableTask();
    const a = limiter.run(first.task);
    const b = limiter.run(async () => order.push('b'));
    const c = limiter.run(async () => order.push('c'));
    await tick();
    expect(order).toEqual([]);
    first.finish();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['b', 'c']);
  });

  test('a failing task gives its slot back', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
    expect(limiter.running).toBe(0);
  });

  test('a waiting task that is aborted leaves the queue and never runs', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const holder = controllableTask();
    const running = limiter.run(holder.task);
    const controller = new AbortController();
    const waiting = controllableTask();
    const queued = limiter.run(waiting.task, controller.signal);
    await tick();
    expect(limiter.waiting).toBe(1);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(limiter.waiting).toBe(0);

    holder.finish();
    await running;
    expect(waiting.started).toBe(false);
    // The aborted waiter did not take the slot with it.
    expect(limiter.running).toBe(0);
    await expect(limiter.run(async () => 'free')).resolves.toBe('free');
  });

  test('an already-aborted signal rejects without running the task', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const task = controllableTask();
    await expect(limiter.run(task.task, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(task.started).toBe(false);
    expect(limiter.running).toBe(0);
  });

  test('aborting a RUNNING task does not cancel it: the signal only guards the wait', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const controller = new AbortController();
    const running = controllableTask();
    const promise = limiter.run(running.task, controller.signal);
    await tick();
    controller.abort();
    running.finish();
    await expect(promise).resolves.toBe('ok');
  });
});
