'use client';

import { useCallback } from 'react';

import type { ChatAction } from '@/app/lib/chatStore';

import { type Attachment } from '@/components/ChatInput';

/**
 * Creates the `handleSend` callback that dispatches a user message or
 * slash command, including the attachment-warning logic for slash commands.
 */
export function useSendHandler(
  dispatch: React.Dispatch<ChatAction>,
  handleSlashCommand: (command: string) => Promise<void>,
  sendChatMessage: (message: string, attachments: Attachment[]) => Promise<void>
) {
  return useCallback(
    async (message: string, attachments: Attachment[]) => {
      const trimmed = message.trim();
      const hasAttachments = attachments.length > 0;
      if (!trimmed && !hasAttachments) return;
      dispatch({ type: 'CLEAR_COMPACT_PROGRESS' });
      // Slash commands don't accept attachments — warn if the user had some pending.
      if (trimmed.startsWith('/')) {
        if (hasAttachments) {
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'system',
              content: `Attachments are not supported with slash commands. Your ${attachments.length} file(s) were not sent.`,
            },
          });
        }
        await handleSlashCommand(trimmed);
      } else {
        await sendChatMessage(message, attachments);
      }
    },
    [dispatch, handleSlashCommand, sendChatMessage]
  );
}
