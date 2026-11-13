'use client';

import { type Dispatch, useCallback, useRef, useState } from 'react';

import type { ChatMessage, Session } from '@/app/lib/chatStore';
import type { LatestGate } from '@/app/lib/latestGate';
import type { SessionSelection } from '@/services/sessionSelection';

import { DEFAULT_SESSION_NAME } from '@/constants';

import type { WritableRef } from './useStableRefs';

// Minimal set of action shapes consumed here
type SessionAction =
  | { type: 'SET_CURRENT_SESSION'; id: number | null }
  | { type: 'ADD_SESSION'; session: Session }
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
  /** The order of the user's navigations; the last click decides the view. */
  navigation: LatestGate;
  /** The model selection the new conversation is born with. */
  selection: SessionSelection;
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
 * filtered list. Opening a conversation and starting a new chat both take a
 * turn in the shared navigation order, so the LAST click decides what is on
 * screen and a late load or a slow server call cannot take the view back.
 */
export function useSessionActions({
  dispatch,
  sessionIdRef,
  loadSessions,
  loadSessionMessages,
  navigation,
  selection,
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
    // Taking a turn in the navigation order right away makes any conversation
    // that is still loading from an earlier click stale: it can no longer
    // arrive afterwards and take the view back from the new chat. It also
    // lets a click made while the server is still creating this chat win
    // over it.
    const turn = navigation.begin();
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: DEFAULT_SESSION_NAME,
          model: selection.model,
          providerId: selection.providerId,
          compactionModel: selection.compactionModel,
          compactionProviderId: selection.compactionProviderId,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { session: Session };
        dispatch({ type: 'ADD_SESSION', session: data.session });
        if (navigation.isLatest(turn)) {
          dispatch({ type: 'SET_CURRENT_SESSION', id: data.session.id });
        }
        await loadSessions();
        return;
      }
    } catch {
      // Fallback to in-memory new session if the backend is unreachable
    }
    if (navigation.isLatest(turn)) {
      dispatch({ type: 'SET_CURRENT_SESSION', id: null });
    }
    await loadSessions();
  }, [dispatch, loadSessions, navigation, selection]);

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
