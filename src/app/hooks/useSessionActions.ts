'use client';

import { type Dispatch, useCallback, useRef, useState } from 'react';

import type { ChatMessage } from '@/app/lib/chatStore';

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
  | { type: 'CLEAR_MESSAGES' }
  | {
      type: 'SET_MESSAGES';
      messages: ChatMessage[];
      targetSessionId?: number;
      allowEmptyWhileStreaming?: boolean;
    }
  | { type: 'CLEAR_TOKEN_STATS'; targetSessionId?: number };

interface UseSessionActionsOptions {
  dispatch: Dispatch<SessionAction>;
  sessionIdRef: WritableRef<number | null>;
  loadSessions: (query?: string) => Promise<void>;
  loadSessionMessages: (
    id: number,
    allowEmptyWhileStreaming?: boolean,
    options?: { keepCurrentSession?: boolean }
  ) => Promise<void>;
  model: string;
}

interface UseSessionActionsResult {
  handleNewSession: () => Promise<void>;
  handleSelectSession: (sessionId: number) => Promise<void>;
  handleDeleteSession: (id: number) => Promise<void>;
  handleDeletePrompt: (sessionId: number, messageId: number) => Promise<void>;
  isDeletingPrompt: boolean;
  handleSearchSessions: (query: string) => Promise<void>;
}

/**
 * Encapsulates session lifecycle actions: create, select, delete, and search.
 * Tracks the latest search query so deletions can refresh the correct
 * filtered list. Stale loads from rapid switching are discarded by
 * `loadSessionMessages`' own "latest wins" token.
 */
export function useSessionActions({
  dispatch,
  sessionIdRef,
  loadSessions,
  loadSessionMessages,
  model,
}: UseSessionActionsOptions): UseSessionActionsResult {
  const currentSearchQueryRef = useRef('');
  const deletePromptRequestIdRef = useRef(0);
  const [isDeletingPrompt, setIsDeletingPrompt] = useState(false);

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
      sessionIdRef.current = sessionId;
      dispatch({ type: 'SET_CURRENT_SESSION', id: sessionId });
      // A session that is still streaming is restored from its live slot by
      // the switch above; `loadSessionMessages` leaves it alone rather than
      // overwrite it with the database's partial copy.
      await loadSessionMessages(sessionId);
    },
    [dispatch, sessionIdRef, loadSessionMessages]
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

  const handleDeletePrompt = useCallback(
    async (targetSessionId: number, messageId: number) => {
      if (isDeletingPrompt) return;
      const requestId = deletePromptRequestIdRef.current + 1;
      deletePromptRequestIdRef.current = requestId;
      setIsDeletingPrompt(true);

      try {
        const res = await fetch(`/api/sessions/${targetSessionId}/messages/${messageId}`, {
          method: 'DELETE',
        });
        if (deletePromptRequestIdRef.current !== requestId) return;

        if (!res.ok) {
          console.error('Failed to delete prompt:', await res.text());
          return;
        }

        await res.json();
        if (deletePromptRequestIdRef.current !== requestId) return;

        // Only update the UI if we're still viewing the same session.
        if (sessionIdRef.current === targetSessionId) {
          // The reload must not change the view: the user may have moved to
          // another session while the delete was in flight, and the caller
          // has already decided this refresh is only for the session that
          // was being read.
          await loadSessionMessages(targetSessionId, true, { keepCurrentSession: true });
          dispatch({ type: 'CLEAR_TOKEN_STATS', targetSessionId });
        }
      } catch (err) {
        console.error('Failed to delete prompt:', err);
      } finally {
        if (deletePromptRequestIdRef.current === requestId) {
          setIsDeletingPrompt(false);
        }
      }
    },
    [dispatch, isDeletingPrompt, loadSessionMessages, sessionIdRef]
  );

  return {
    handleNewSession,
    handleSelectSession,
    handleDeleteSession,
    handleDeletePrompt,
    isDeletingPrompt,
    handleSearchSessions,
  };
}
