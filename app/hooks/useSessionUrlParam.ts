'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useChat } from '@/app/lib/chatStore';

interface UseSessionUrlParamOptions {
  onLoadSessionMessages: (sessionId: number) => Promise<void>;
}

/**
 * Bi‑directional sync between ?session=<id> URL parameter and app state.
 *
 * On mount (and on browser back/forward navigation) the URL param is read
 * and the session is loaded.  When the user selects a different session
 * inside the app, the URL is updated to match.
 */
export function useSessionUrlParam({ onLoadSessionMessages }: UseSessionUrlParamOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { state, dispatch } = useChat();

  // ── Guards ────────────────────────────────────────────────────────────────
  // Set before we write to the URL, cleared when the URL→state effect sees it.
  // Prevents treating our own router.replace calls as browser navigation.
  const isPushingRef = useRef(false);

  // Mirrors state.currentSessionId so the URL→state effect only depends on
  // searchParams (not on state.currentSessionId), avoiding re‑run loops.
  const currentSessionIdRef = useRef(state.currentSessionId);
  currentSessionIdRef.current = state.currentSessionId;

  // Tracks whether the state→URL effect has run at least once.  Used to
  // prevent the initial render from clearing a session param that the
  // URL→state effect is about to restore.
  const isInitialMountRef = useRef(true);
  // ──────────────────────────────────────────────────────────────────────────

  // ═══════════════════════════════════════════════════════════════════════════
  // URL → state  (mount, back/forward, manual address‑bar edit)
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    // Ignore URL changes that *we* initiated (state → URL below).
    if (isPushingRef.current) {
      isPushingRef.current = false;
      return;
    }

    const urlParam = searchParams.get('session');
    const current = currentSessionIdRef.current;

    if (urlParam) {
      const id = parseInt(urlParam, 10);
      if (id > 0 && id !== current) {
        dispatch({ type: 'SET_CURRENT_SESSION', id });
        onLoadSessionMessages(id);
      }
    }
    // If urlParam is absent and we have a current session, we leave it alone —
    // clearing the URL param is only done intentionally from within the app
    // (New Session, etc.), never by external navigation.
    //
    // Strict‑Mode double‑fire is harmless here: on the second pass
    // currentSessionIdRef.current already equals id, so the branch is skipped.
  }, [searchParams, dispatch, onLoadSessionMessages]);

  // ═══════════════════════════════════════════════════════════════════════════
  // state → URL  (session selection inside the app)
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const current = state.currentSessionId;
    const urlParam = searchParams.get('session');

    if (current === null) {
      // No session selected — clear the URL param if present.
      // Skip on the very first run so we don't delete a ?session=<id>
      // that the URL→state effect (running first in the same commit)
      // is about to restore.
      if (urlParam !== null && !isInitialMountRef.current) {
        isPushingRef.current = true;
        const url = new URL(window.location.href);
        url.searchParams.delete('session');
        router.replace(url.pathname + url.search);
      }
    } else if (String(current) !== urlParam) {
      // Session changed — write ?session=<id> to the URL.
      isPushingRef.current = true;
      const url = new URL(window.location.href);
      url.searchParams.set('session', String(current));
      router.replace(url.pathname + url.search);
    }

    isInitialMountRef.current = false;
  }, [state.currentSessionId]);
}
