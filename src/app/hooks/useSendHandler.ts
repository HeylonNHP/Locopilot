'use client';

import { useCallback } from 'react';

import type { ChatAction } from '@/app/lib/chatStore';

import { type Attachment } from '@/components/ChatInput';
import { classifySlashInput } from '@/services/slashCommands';

/**
 * Reports whether the handler consumed the composer's content.
 *
 * `false` means nothing was sent, so the caller must KEEP the text in the
 * input rather than clearing it. Handlers that cannot answer synchronously
 * may return a promise; only an explicit `false` restores the text.
 */
export type SendHandler = (
  message: string,
  attachments: Attachment[]
) => boolean | Promise<boolean>;

/**
 * Creates the `handleSend` callback that dispatches a user message or
 * slash command, including the attachment-warning logic for slash commands.
 *
 * Routing is decided by `classifySlashInput`, not by `startsWith('/')`: a
 * message that merely begins with a slash because it contains a path is sent
 * to the model as an ordinary message instead of being eaten by the command
 * dispatcher.
 */
export function useSendHandler(
  dispatch: React.Dispatch<ChatAction>,
  handleSlashCommand: (command: string) => Promise<void>,
  sendChatMessage: (message: string, attachments: Attachment[]) => Promise<void>
): SendHandler {
  return useCallback(
    (message: string, attachments: Attachment[]) => {
      const trimmed = message.trim();
      const hasAttachments = attachments.length > 0;
      if (!trimmed && !hasAttachments) return false;
      dispatch({ type: 'CLEAR_COMPACT_PROGRESS' });

      const route = classifySlashInput(trimmed);

      if (route.kind === 'unknown-command') {
        // A bare "/foo" that matches no command is probably a typo, so say so
        // — but return false so the composer keeps the text for editing.
        dispatch({
          type: 'ADD_MESSAGE',
          message: {
            role: 'system',
            content: `Unknown command: /${route.name}. Type /help for available commands.`,
          },
        });
        return false;
      }

      if (route.kind === 'command') {
        // Slash commands don't accept attachments — warn if the user had some pending.
        if (hasAttachments) {
          dispatch({
            type: 'ADD_MESSAGE',
            message: {
              role: 'system',
              content: `Attachments are not supported with slash commands. Your ${attachments.length} file(s) were not sent.`,
            },
          });
        }
        return handleSlashCommand(trimmed).then(
          () => true,
          () => true
        );
      }

      // Everything else — including a message that starts with a slash because
      // it is a path — is a normal chat turn. The stream is not awaited here,
      // so the composer learns "consumed" as soon as the turn is dispatched.
      void sendChatMessage(message, attachments).catch((err: unknown) => {
        dispatch({
          type: 'SET_ERROR',
          error: `Failed to send message: ${err instanceof Error ? err.message : 'Unknown error'}`,
        });
      });
      return true;
    },
    [dispatch, handleSlashCommand, sendChatMessage]
  );
}
