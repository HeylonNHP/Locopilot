'use client';
import React from 'react';

import { type ChatMessage } from '@/app/lib/chatStore';

import { AttachmentImages } from '../AttachmentImages';

import './UserMessageBubble.scss';

interface Props {
  message: ChatMessage;
}

export function UserMessageBubble({ message }: Props) {
  return (
    <div className="bubble-user-wrap">
      <div className="bubble-user">
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
