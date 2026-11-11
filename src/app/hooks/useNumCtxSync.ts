'use client';

import { useEffect, useRef } from 'react';

import { shouldRefetchNumCtx } from '@/app/lib/contextWindow';

/**
 * Keeps the context window the page shows in step with the server.
 *
 * It asks the server (`loadNumCtx`, which calls `GET /api/numctx`):
 *
 * - when the selected model or provider changes, and when the saved setting
 *   changes (a Settings save, `/ctx`, a config load) — the server's answer is
 *   for a particular model and setting;
 * - when the window regains focus, at most once every 30 seconds
 *   (`NUMCTX_FOCUS_REFETCH_MS`) — a tab left open while the config changed
 *   elsewhere would otherwise keep showing a window the server no longer uses.
 *
 * Nothing is computed here; `loadNumCtx` stores what the server says. With no
 * model selected yet (the config has not loaded) it does nothing.
 */
export function useNumCtxSync(
  loadNumCtx: () => Promise<void>,
  model: string,
  providerId: string | null,
  requestedNumCtx: number | null
): void {
  const lastFetchedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!model) {
      return;
    }
    lastFetchedAtRef.current = Date.now();
    void loadNumCtx();
  }, [loadNumCtx, model, providerId, requestedNumCtx]);

  useEffect(() => {
    const refetchOnFocus = (): void => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      const now = Date.now();
      if (!shouldRefetchNumCtx(now, lastFetchedAtRef.current)) {
        return;
      }
      lastFetchedAtRef.current = now;
      void loadNumCtx();
    };
    window.addEventListener('focus', refetchOnFocus);
    document.addEventListener('visibilitychange', refetchOnFocus);
    return () => {
      window.removeEventListener('focus', refetchOnFocus);
      document.removeEventListener('visibilitychange', refetchOnFocus);
    };
  }, [loadNumCtx]);
}
