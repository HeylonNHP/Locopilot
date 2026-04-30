'use client';

import { type ChatMessage } from '@/app/lib/chatStore';
import { useEffect, useState } from 'react';
import MarkdownMessage from './MarkdownMessage';

interface Props {
  message: ChatMessage;
}

export default function ChatMessageBubble({ message }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const hasThinking = Boolean(message.thinking?.trim());
  const hasContent = Boolean(message.content?.trim());

  useEffect(() => {
    if (hasThinking && !hasContent) {
      setShowThinking(true);
    }
  }, [hasThinking, hasContent]);
  
  if (message.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
        <div style={{
          maxWidth: '70%',
          padding: '10px 16px',
          borderRadius: '16px 16px 4px 16px',
          background: 'var(--accent)',
          color: 'white',
          fontSize: '14px',
          lineHeight: '1.5',
        }}>
          {message.content}
        </div>
      </div>
    );
  }
  
  if (message.role === 'tool') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '4px' }}>
        <div style={{
          maxWidth: '90%',
          padding: '8px 12px',
          borderRadius: '8px',
          background: 'var(--bg-tertiary)',
          border: '1px solid #333',
          fontFamily: 'monospace',
          fontSize: '12px',
          color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap',
          overflow: 'auto',
          maxHeight: '200px',
        }}>
          {message.content}
        </div>
      </div>
    );
  }
  
  if (message.role === 'system') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
        <div style={{
          maxWidth: '80%',
          padding: '8px 12px',
          borderRadius: '8px',
          background: 'var(--bg-tertiary)',
          border: '1px solid #444',
          fontSize: '13px',
          lineHeight: '1.5',
          color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap',
          textAlign: 'center',
        }}>
          {message.content}
        </div>
      </div>
    );
  }

  // AI message
  return (
    <div style={{ marginBottom: '12px' }}>
      {hasThinking && (
        <div style={{ marginBottom: '4px' }}>
          <button
            onClick={() => setShowThinking(!showThinking)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '12px',
              padding: '4px 0',
            }}
          >
            {showThinking ? 'Hide' : 'Show'} reasoning ({message.thinking?.length ?? 0} chars)
          </button>
          {showThinking && (
            <div style={{
              padding: '8px 12px',
              background: 'var(--bg-tertiary)',
              borderRadius: '8px',
              fontSize: '13px',
              color: 'var(--text-secondary)',
              borderLeft: '3px solid var(--accent)',
              marginTop: '4px',
            }}>
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
          style={{
            maxWidth: '80%',
            padding: '10px 16px',
            borderRadius: '16px 16px 16px 4px',
            background: 'var(--bg-secondary)',
            border: '1px solid #333',
            fontSize: '14px',
            lineHeight: '1.6',
            whiteSpace: 'normal',
            cursor: hasThinking && !hasContent ? 'pointer' : 'default',
          }}
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
