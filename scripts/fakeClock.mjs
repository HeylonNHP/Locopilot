/**
 * A manual clock for testing code that is driven by timers.
 *
 * `schedule` and `cancel` have the shape the batched dispatcher takes
 * (`src/app/lib/updateBatcher.ts`); `advance(ms)` moves time forward and runs
 * every timer that falls due, in order.
 *
 * Handles start at 0 on purpose: code that treats a falsy handle as "no
 * timer" fails against this clock, as it would against a real one.
 */
export function createFakeClock() {
  let now = 0;
  let nextHandle = 0;
  const timers = new Map();

  return {
    schedule(callback, ms) {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { callback, at: now + ms });
      return handle;
    },
    cancel(handle) {
      timers.delete(handle);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [handle, timer] = due;
        timers.delete(handle);
        now = timer.at;
        timer.callback();
      }
      now = end;
    },
    /** How many timers are waiting. */
    pending() {
      return timers.size;
    },
  };
}
