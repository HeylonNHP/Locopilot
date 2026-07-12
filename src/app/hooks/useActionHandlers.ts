'use client';

import { type Dispatch, useCallback } from 'react';

import type { ChatAction } from '@/app/lib/chatStore';

import { type Attachment } from '@/components/ChatInput';

import type { WritableRef } from './useStableRefs';

/**
 * Groups the `handleStop` and `handleSkillPrompt` callbacks that were
 * previously defined inline in HomeInner.
 */
export function useActionHandlers(
  abortControllersRef: WritableRef<Map<number, AbortController>>,
  isCurrentSessionStreaming: boolean,
  handleSend: (message: string, attachments: Attachment[]) => Promise<void>,
  dispatch: Dispatch<ChatAction>,
  /**
   * The session id the user is currently viewing. `handleStop` only
   * aborts THAT session's stream — never a different session's, and
   * never the COMPACTION_ABORT_KEY used by /compact, /title, /dump.
   * With two browser tabs open against the same server, this is the
   * key invariant that keeps "Stop in tab A" from killing tab B's
   * in-flight stream (and the LLM call it represents).
   */
  visibleSessionId: number | null | undefined,
  /**
   * The keys reserved for non-session work (compact / title / dump).
   * `handleStop` ignores these so the user can keep using compact /
   * title / dump in another tab without their aborts being lost when
   * the foreground tab's Stop button is pressed.
   */
  reservedKeys: ReadonlySet<number>
) {
  const handleStop = useCallback(() => {
    // Only abort the visible session's stream. Iterating
    // `abortControllersRef.current.values()` would abort every other
    // session's stream and the reserved keys, which used to be the
    // pre-fix behaviour and was the root cause of bug #1 (Stop in
    // tab A killing tab B's in-flight chat).
    if (visibleSessionId === null || visibleSessionId === undefined) return;
    if (reservedKeys.has(visibleSessionId)) return;
    const controller = abortControllersRef.current.get(visibleSessionId);
    if (controller) {
      controller.abort();
    }
    // Note: do NOT delete entries here — the `finally` block in useChatStream's
    // retry / sendChatMessage deletes them on its own. Deleting here would race
    // with that cleanup and break the bookkeeping.
  }, [abortControllersRef, visibleSessionId, reservedKeys]);

  const handleSkillPrompt = useCallback(
    (message: string) => {
      if (isCurrentSessionStreaming) {
        dispatch({
          type: 'ADD_MESSAGE',
          message: {
            role: 'system',
            content: 'Cannot manage skills while the AI is responding. Stop the response first.',
          },
        });
        return;
      }
      void handleSend(message, []);
    },
    [isCurrentSessionStreaming, handleSend, dispatch]
  );

  return { handleStop, handleSkillPrompt };
}
