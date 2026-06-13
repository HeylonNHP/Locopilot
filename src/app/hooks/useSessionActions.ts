'use client';

import { type Dispatch, useCallback, useRef } from 'react';

import { DEFAULT_SESSION_NAME } from '@/constants';

import type { WritableRef } from './useStableRefs';

// Minimal set of action shapes consumed here
type SessionAction =
  | { type: 'SET_CURRENT_SESSION'; id: number | null }
  | {
      type: 'ADD_SESSION';
      session: { id: number; name: string; model: string; created_at: string; updated_at: string };
    }
  | { type: 'DISCARD_SESSION'; sessionId: number }
  | { type: 'CLEAR_MESSAGES' };

interface UseSessionActionsOptions {
  dispatch: Dispatch<SessionAction>;
  sessionIdRef: WritableRef<number | null>;
  loadSessions: (query?: string) => Promise<void>;
  loadSessionMessages: (id: number) => Promise<void>;
  replayBufferedEvents: (id: number) => void;
  model: string;
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
  model,
}: UseSessionActionsOptions): UseSessionActionsResult {
  const sessionSwitchIdRef = useRef<number | null>(null);
  const currentSearchQueryRef = useRef('');

  const handleSearchSessions = useCallback(
    async (query: string) => {
      currentSearchQueryRef.current = query;
      await loadSessions(query.trim() ? query : undefined);
    },
    [loadSessions]
  );

  const handleNewSession = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: DEFAULT_SESSION_NAME, model }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          session: {
            id: number;
            name: string;
            model: string;
            created_at: string;
            updated_at: string;
          };
        };
        dispatch({ type: 'ADD_SESSION', session: data.session });
        dispatch({ type: 'SET_CURRENT_SESSION', id: data.session.id });
        await loadSessions();
        return;
      }
    } catch {
      // Fallback to in-memory new session if the backend is unreachable
    }
    dispatch({ type: 'SET_CURRENT_SESSION', id: null });
    await loadSessions();
  }, [dispatch, loadSessions, model]);

  const handleSelectSession = useCallback(
    async (sessionId: number) => {
      sessionSwitchIdRef.current = sessionId;
      sessionIdRef.current = sessionId;
      dispatch({ type: 'SET_CURRENT_SESSION', id: sessionId });
      await loadSessionMessages(sessionId);
      // Bail out if the user switched to a different session while this was loading
      if (sessionSwitchIdRef.current !== sessionId) return;
      replayBufferedEvents(sessionId);
    },
    [dispatch, loadSessionMessages, replayBufferedEvents]
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
    [dispatch, sessionIdRef, loadSessions]
  );

  return { handleNewSession, handleSelectSession, handleDeleteSession, handleSearchSessions };
}
