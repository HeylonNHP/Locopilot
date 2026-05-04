'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useChat } from '@/app/lib/chatStore';

interface UseSessionUrlParamOptions {
  onLoadSessionMessages: (sessionId: number) => Promise<void>;
}

/**
 * Reads the ?session=<id> URL parameter on mount and loads that session if present.
 * Also keeps the URL in sync whenever the current session changes.
 *
 * Must be used inside a Next.js Client Component (uses useRouter/useSearchParams).
 */
export function useSessionUrlParam({ onLoadSessionMessages }: UseSessionUrlParamOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state, dispatch } = useChat();

  // ── On mount: restore session from URL param ────────────────────────────────
  useEffect(() => {
    const sessionIdParam = searchParams.get('session');
    if (sessionIdParam) {
      const sessionId = parseInt(sessionIdParam, 10);
      if (!isNaN(sessionId) && sessionId > 0) {
        dispatch({ type: 'SET_CURRENT_SESSION', id: sessionId });
        onLoadSessionMessages(sessionId);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  // ── Keep URL in sync with currentSessionId ──────────────────────────────────
  useEffect(() => {
    const current = state.currentSessionId;
    const urlParam = searchParams.get('session');

    if (current === null) {
      // New / no session — remove ?session param if it exists
      if (urlParam !== null) {
        const url = new URL(window.location.href);
        url.searchParams.delete('session');
        router.replace(url.pathname + url.search);
      }
    } else if (String(current) !== urlParam) {
      // Session changed — push new ?session=<id>
      const url = new URL(window.location.href);
      url.searchParams.set('session', String(current));
      router.replace(url.pathname + url.search);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentSessionId]);
}