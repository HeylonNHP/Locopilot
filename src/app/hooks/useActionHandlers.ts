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
  currentSessionId: number | null,
  isCurrentSessionStreaming: boolean,
  handleSend: (message: string, attachments: Attachment[]) => Promise<void>,
  dispatch: Dispatch<ChatAction>
) {
  const handleStop = useCallback(() => {
    const controller = abortControllersRef.current.get(currentSessionId ?? -1);
    controller?.abort();
  }, [abortControllersRef, currentSessionId]);

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
      handleSend(message, []);
    },
    [isCurrentSessionStreaming, handleSend, dispatch]
  );

  return { handleStop, handleSkillPrompt };
}
