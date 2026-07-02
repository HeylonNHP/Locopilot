'use client';
import React from 'react';

import { type ChatMessage } from '@/app/lib/chatStore';

import './ToolMessageBubble.scss';

interface Props {
  message: ChatMessage;
}

export function ToolMessageBubble({ message }: Props) {
  return (
    <div className="bubble-tool-wrap">
      <div className="bubble-tool">
        <div className="bubble-tool-content">{message.content}</div>
      </div>
    </div>
  );
}
