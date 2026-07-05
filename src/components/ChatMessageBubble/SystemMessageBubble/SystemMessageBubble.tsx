'use client';
import React from 'react';

import { type ChatMessage } from '@/app/lib/chatStore';

import './SystemMessageBubble.scss';

interface Props {
  message: ChatMessage;
}

export function SystemMessageBubble({ message }: Props) {
  return (
    <div className="bubble-system-wrap">
      <div className="bubble-system">{message.content}</div>
    </div>
  );
}
