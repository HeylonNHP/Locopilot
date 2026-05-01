'use client';

import { type ChatMessage } from '@/app/lib/chatStore';
import { useEffect, useRef, useState } from 'react';
import MarkdownMessage from './MarkdownMessage';

interface Props {
  message: ChatMessage;
}

export default function ChatMessageBubble({ message }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const [subagentCollapsed, setSubagentCollapsed] = useState(false);
  const subagentLogRef = useRef<HTMLPreElement>(null);
  const hasThinking = Boolean(message.thinking?.trim());
  const hasContent = Boolean(message.content?.trim());

  useEffect(() => {
    if (hasThinking && !hasContent) {
      setShowThinking(true);
    }
  }, [hasThinking, hasContent]);

  // Auto-scroll the subagent log to the bottom as new lines arrive.
  useEffect(() => {
    if (!subagentCollapsed && subagentLogRef.current) {
      subagentLogRef.current.scrollTop = subagentLogRef.current.scrollHeight;
    }
  }, [message.content, subagentCollapsed]);
  
  if (message.role === 'user') {
    return (
      <div className="bubble-user-wrap">
        <div className="bubble-user">
          {message.content}
        </div>
      </div>
    );
  }
  
  if (message.role === 'tool') {
    return (
      <div className="bubble-tool-wrap">
        <div className="bubble-tool">
          <div className="bubble-tool-content">
            {message.content}
          </div>
        </div>
      </div>
    );
  }
  
  if (message.role === 'system') {
    return (
      <div className="bubble-system-wrap">
        <div className="bubble-system">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === 'subagent_log') {
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
            <span>{subagentCollapsed ? '\u25b6' : '\u25bc'}</span>
            <span>🤖 Sub-agent: {message.subagentId ?? 'unknown'}</span>
          </button>
          {!subagentCollapsed && (
            <pre
              ref={subagentLogRef}
              className="bubble-subagent-log"
            >
              {message.content || 'Waiting...'}
            </pre>
          )}
        </div>
      </div>
    );
  }

  // AI message
  return (
    <div className="bubble-ai-wrap">
      {hasThinking && (
        <div className="mb-4">
          <button
            onClick={() => setShowThinking(!showThinking)}
            className="bubble-thinking-btn"
          >
            {showThinking ? 'Hide' : 'Show'} reasoning ({message.thinking?.length ?? 0} chars)
          </button>
          {showThinking && (
            <div className="bubble-thinking-box">
              <MarkdownMessage source={message.thinking ?? ''} className="markdown-message--thinking" />
            </div>
          )}
        </div>
      )}
      {hasContent || !hasThinking || !showThinking ? (
        <div
          onClick={hasThinking && !hasContent ? () => setShowThinking((prev) => !prev) : undefined}
          onKeyDown={
            hasThinking && !hasContent
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setShowThinking((prev) => !prev);
                  }
                }
              : undefined
          }
          role={hasThinking && !hasContent ? 'button' : undefined}
          tabIndex={hasThinking && !hasContent ? 0 : undefined}
          title={hasThinking && !hasContent ? (showThinking ? 'Hide reasoning' : 'Show reasoning') : undefined}
          className={`bubble-ai-msg${hasThinking && !hasContent ? ' cursor-pointer' : ''}`}
        >
          {hasContent || message.role !== 'assistant' ? (
            <MarkdownMessage source={message.content} />
          ) : (
            '...'
          )}
        </div>
      ) : null}
    </div>
  );
}
