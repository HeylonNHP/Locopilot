/**
 * A counting semaphore for async work: at most `maxConcurrent` tasks run at
 * once, the rest wait their turn in arrival order.
 *
 * A waiting task can be cancelled with an `AbortSignal`; it then leaves the
 * queue and rejects, and never holds or consumes a slot.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError(`maxConcurrent must be a positive integer, got ${maxConcurrent}`);
    }
  }

  /** Tasks running right now. */
  get running(): number {
    return this.active;
  }

  /** Tasks waiting for a slot. */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Runs `task` once a slot is free and gives the slot back when it settles
   * (resolved or rejected). Rejects without running `task` if `signal` aborts
   * while waiting.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const at = this.waiters.indexOf(waiter);
        if (at !== -1) this.waiters.splice(at, 1);
        reject(abortReason(signal));
      };
      // The slot is handed over, not released and re-taken: `active` stays put.
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active -= 1;
    }
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}
