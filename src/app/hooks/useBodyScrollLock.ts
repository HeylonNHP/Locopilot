'use client';

import { useEffect } from 'react';

let locks = 0;
let savedOverflow = '';

/**
 * Reference-counted body scroll lock. With this hook (rather than directly
 * styling `body`) several overlays can be open at once without fighting, and
 * the original overflow value is restored only when the last one closes.
 *
 * SSR-safe: effects run on the client only.
 */
export function useBodyScrollLock(enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    if (locks === 0) {
      savedOverflow = globalThis.getComputedStyle(document.body).overflow;
    }
    locks += 1;
    document.body.style.overflow = 'hidden';

    return () => {
      locks = Math.max(0, locks - 1);
      if (locks === 0) {
        document.body.style.overflow = savedOverflow;
        savedOverflow = '';
      }
    };
  }, [enabled]);
}

/** Test-only: release any lingering locks. */
export function __resetBodyScrollLockForTests(): void {
  locks = 0;
  savedOverflow = '';
  if (typeof document !== 'undefined') document.body.style.overflow = '';
}
