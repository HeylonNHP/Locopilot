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
  dispatch: Dispatch<ChatAction>
) {
  const handleStop = useCallback(() => {
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    // Note: do NOT delete entries here — the `finally` block in useChatStream's
    // retry / sendChatMessage deletes them on its own. Deleting here would race
    // with that cleanup and break the bookkeeping.
  }, [abortControllersRef]);

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
