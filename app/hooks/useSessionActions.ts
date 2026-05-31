'use client';

import { useCallback, useRef } from 'react';
import type { Dispatch } from 'react';
import type { WritableRef } from './useStableRefs';

// Minimal set of action shapes consumed here
type SessionAction =
  | { type: 'SET_CURRENT_SESSION'; id: number | null }
  | { type: 'DISCARD_SESSION'; sessionId: number }
  | { type: 'CLEAR_MESSAGES' };

interface UseSessionActionsOptions {
  dispatch: Dispatch<SessionAction>;
  sessionIdRef: WritableRef<number | null>;
  loadSessions: (query?: string) => Promise<void>;
  loadSessionMessages: (id: number) => Promise<void>;
  replayBufferedEvents: (id: number) => void;
}

interface UseSessionActionsResult {
  handleNewSession: () => Promise<void>;
  handleSelectSession: (sessionId: number) => Promise<void>;
  handleDeleteSession: (id: number) => Promise<void>;
  handleSearchSessions: (query: string) => Promise<void>;
}

/**
 * Encapsulates session lifecycle actions: create, select, delete, and search.
 * Manages a `sessionSwitchIdRef` internally to cancel stale loads when the
 * user switches sessions rapidly, and tracks the latest search query so
 * deletions can refresh the correct filtered list.
 */
export function useSessionActions({
  dispatch,
  sessionIdRef,
  loadSessions,
  loadSessionMessages,
  replayBufferedEvents,
}: UseSessionActionsOptions): UseSessionActionsResult {
  const sessionSwitchIdRef = useRef<number | null>(null);
  const currentSearchQueryRef = useRef('');

  const handleSearchSessions = useCallback(
    async (query: string) => {
      currentSearchQueryRef.current = query;
      await loadSessions(query.trim() ? query : undefined);
    },
    [loadSessions],
  );

  const handleNewSession = useCallback(async () => {
    dispatch({ type: 'SET_CURRENT_SESSION', id: null });
    await loadSessions();
  }, [dispatch, loadSessions]);

  const handleSelectSession = useCallback(
    async (sessionId: number) => {
      sessionSwitchIdRef.current = sessionId;
      dispatch({ type: 'SET_CURRENT_SESSION', id: sessionId });
      await loadSessionMessages(sessionId);
      // Bail out if the user switched to a different session while this was loading
      if (sessionSwitchIdRef.current !== sessionId) return;
      replayBufferedEvents(sessionId);
    },
    [dispatch, loadSessionMessages, replayBufferedEvents],
  );

  const handleDeleteSession = useCallback(
    async (id: number) => {
      try {
        await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
        const q = currentSearchQueryRef.current;
        await loadSessions(q.trim() ? q : undefined);
        dispatch({ type: 'DISCARD_SESSION', sessionId: id });
        if (sessionIdRef.current === id) {
          dispatch({ type: 'CLEAR_MESSAGES' });
          dispatch({ type: 'SET_CURRENT_SESSION', id: null });
        }
      } catch {
        // Silently ignore — session list will be stale but not broken
      }
    },
    [dispatch, sessionIdRef, loadSessions],
  );

  return { handleNewSession, handleSelectSession, handleDeleteSession, handleSearchSessions };
}
