'use client';

import { useCallback, useMemo } from 'react';

import { selectUserMessages, useChat } from '@/app/lib/chatStore';

export interface UseInputHistoryResult {
  /** List of user message content strings in chronological order. */
  history: string[];
  /** Current index in history, or null if not browsing history. */
  historyIndex: number | null;
  /** True if a history entry is currently active (not the draft). */
  isBrowsingHistory: boolean;
  /** Replace the current input value and start/continue browsing history. Returns the text to put in the input, or null if navigation cannot happen. */
  goBack(currentInput: string): string | null;
  goForward(currentInput: string): string | null;
  /** Restore the draft and exit history mode. */
  cancel(): void;
}

export function useInputHistory(): UseInputHistoryResult {
  const { state, dispatch } = useChat();

  const userMessages = useMemo(() => selectUserMessages(state), [state]);
  const history = useMemo(() => userMessages.map((m) => m.content), [userMessages]);
  const historyIndex = state.historyIndex;
  const isBrowsingHistory = historyIndex !== null;

  const goBack = useCallback(
    (currentInput: string): string | null => {
      if (historyIndex === null) {
        if (history.length === 0) {
          return null;
        }
        const nextIndex = history.length - 1;
        dispatch({ type: 'SAVE_INPUT_DRAFT', draft: currentInput });
        dispatch({ type: 'SET_HISTORY_INDEX', index: nextIndex });
        return history[nextIndex] ?? null;
      }

      if (historyIndex > 0) {
        const nextIndex = historyIndex - 1;
        dispatch({ type: 'SET_HISTORY_INDEX', index: nextIndex });
        return history[nextIndex] ?? null;
      }

      return null;
    },
    [history, historyIndex, dispatch]
  );

  const goForward = useCallback(
    (_currentInput: string): string | null => {
      if (historyIndex === null) {
        return null;
      }

      if (historyIndex < history.length - 1) {
        const nextIndex = historyIndex + 1;
        dispatch({ type: 'SET_HISTORY_INDEX', index: nextIndex });
        return history[nextIndex] ?? null;
      }

      dispatch({ type: 'CLEAR_HISTORY_NAVIGATION' });
      return state.inputDraft;
    },
    [history, historyIndex, state.inputDraft, dispatch]
  );

  const cancel = useCallback(() => {
    dispatch({ type: 'CLEAR_HISTORY_NAVIGATION' });
  }, [dispatch]);

  return useMemo(
    () => ({
      history,
      historyIndex,
      isBrowsingHistory,
      goBack,
      goForward,
      cancel,
    }),
    [history, historyIndex, isBrowsingHistory, goBack, goForward, cancel]
  );
}
