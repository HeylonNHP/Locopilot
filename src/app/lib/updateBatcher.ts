/**
 * Batched dispatch for updates nobody is looking at.
 *
 * While the user reads one conversation, other conversations can be streaming
 * a reply in many small pieces. Every piece used to be dispatched to the store
 * the moment it arrived, and every dispatch re-renders what is on screen — so
 * the cost of reading a big conversation grew with how much was streaming
 * behind it (measured: 253 messages on screen, two background streams, the
 * main thread blocked about half the time).
 *
 * The updates of a conversation that is not on screen are therefore QUEUED
 * (`dispatchBackground`) and applied together at most once per interval. The
 * ordering rule that makes this safe lives here, in one place, instead of at
 * every call site: an ordinary `dispatch` applies whatever is queued FIRST.
 * So a session switch restores a slot that already holds everything that
 * arrived, a reload of the transcript from the database can never be followed
 * by older queued text (which would duplicate it), and a turn's end settles
 * against a complete transcript — without any of those callers knowing the
 * queue exists.
 *
 * There is one queue for all sessions, not one per session: the actions carry
 * the session they belong to, and a single total order is what keeps
 * "flush first" this simple.
 *
 * Timers are injectable so the rule is tested with a fake clock
 * (tests/update-batcher.test.mjs).
 */
export interface BatchedDispatcher<A> {
  /** Apply `action` now — after everything that was queued before it. */
  dispatch(action: A): void;
  /** Queue `action`; queued actions are applied together within one interval. */
  dispatchBackground(action: A): void;
  /** Apply everything that is queued, now. A no-op when nothing is. */
  flush(): void;
}

export interface BatchedDispatcherOptions {
  /** How long the first queued action may wait before the queue is applied. */
  intervalMs: number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createBatchedDispatcher<A>(
  rawDispatch: (action: A) => void,
  options: BatchedDispatcherOptions
): BatchedDispatcher<A> {
  const {
    intervalMs,
    schedule = (callback, ms) => setTimeout(callback, ms),
    cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  let queue: A[] = [];
  let scheduled = false;
  let handle: unknown;

  function flush(): void {
    if (scheduled) {
      cancel(handle);
      scheduled = false;
    }
    if (queue.length === 0) {
      return;
    }
    // Swap before applying, so anything queued while the batch is being
    // applied starts a fresh window instead of being lost.
    const batch = queue;
    queue = [];
    // React applies dispatches made in one task as ONE render.
    for (const action of batch) {
      rawDispatch(action);
    }
  }

  return {
    dispatch(action) {
      flush();
      rawDispatch(action);
    },
    dispatchBackground(action) {
      queue.push(action);
      // A fixed window from the first queued action, not a debounce: a stream
      // that never pauses must still be applied every interval.
      if (!scheduled) {
        scheduled = true;
        handle = schedule(flush, intervalMs);
      }
    },
    flush,
  };
}
