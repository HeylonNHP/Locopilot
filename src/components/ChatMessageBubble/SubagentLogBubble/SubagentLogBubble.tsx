'use client';
import React, { useEffect, useRef, useState } from 'react';

import { type ChatMessage } from '@/app/lib/chatStore';

import './SubagentLogBubble.scss';

interface Props {
  message: ChatMessage;
}

export function SubagentLogBubble({ message }: Props) {
  const [subagentCollapsed, setSubagentCollapsed] = useState(false);
  const subagentLogRef = useRef<HTMLPreElement>(null);

  // Auto-scroll the subagent log to the bottom as new lines arrive.
  useEffect(() => {
    if (!subagentCollapsed && subagentLogRef.current) {
      subagentLogRef.current.scrollTop = subagentLogRef.current.scrollHeight;
    }
  }, [message.content, subagentCollapsed]);

  return (
    <div className="bubble-subagent-wrap">
      <div className="bubble-subagent">
        <button
          onClick={() => setSubagentCollapsed((c) => !c)}
          className={
            subagentCollapsed
              ? 'bubble-subagent-toggle'
              : 'bubble-subagent-toggle bubble-subagent-toggle-open'
          }
        >
          <span>{subagentCollapsed ? '▶' : '▼'}</span>
          <span>🤖 Sub-agent: {message.subagentId ?? 'unknown'}</span>
        </button>
        {!subagentCollapsed && (
          <pre ref={subagentLogRef} className="bubble-subagent-log">
            {message.content || 'Waiting...'}
          </pre>
        )}
      </div>
    </div>
  );
}
