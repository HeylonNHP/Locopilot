'use client';
import React, { useCallback, useState } from 'react';

import { type ChatMessage } from '@/app/lib/chatStore';
import { AttachmentImages } from '@/components/ChatMessageBubble/AttachmentImages';

import './UserMessageBubble.scss';

interface Props {
  message: ChatMessage;
  onDelete?: (() => void) | undefined;
  disabled?: boolean;
}

export function UserMessageBubble({ message, onDelete, disabled }: Props) {
  const [confirming, setConfirming] = useState(false);

  const handleDeleteClick = useCallback(() => {
    if (!onDelete) return;
    if (confirming) {
      onDelete();
      setConfirming(false);
      return;
    }
    setConfirming(true);
    // Auto-cancel the confirmation if the user doesn't click again.
    globalThis.setTimeout(() => setConfirming(false), 3000);
  }, [confirming, onDelete]);

  return (
    <div className="bubble-user-wrap">
      <div className="bubble-user">
        {onDelete && (
          <button
            type="button"
            onClick={handleDeleteClick}
            disabled={disabled || (!confirming && !onDelete)}
            aria-label={confirming ? 'Confirm delete prompt' : 'Delete prompt and its response'}
            className={`bubble-user-delete${confirming ? ' bubble-user-delete--confirm' : ''}`}
            title={confirming ? 'Click again to confirm' : 'Delete this prompt and its response'}
          >
            {confirming ? (
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="2 8 6 12 14 4" />
              </svg>
            ) : (
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 5h10M6 5v8a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V5M7 2h2" />
                <path d="M2 5h12" />
              </svg>
            )}
          </button>
        )}
        {message.createdAt && (
          <div className="bubble-user-timestamp">
            {new Date(message.createdAt).toLocaleString()}
          </div>
        )}
        {message.images && message.images.length > 0 && (
          <AttachmentImages images={message.images} />
        )}
        {message.content}
      </div>
    </div>
  );
}
