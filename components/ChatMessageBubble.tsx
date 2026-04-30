'use client';

import { type ChatMessage } from '@/app/lib/chatStore';
import { useState } from 'react';

interface Props {
  message: ChatMessage;
}

export default function ChatMessageBubble({ message }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  
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
      {message.thinking && (
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
            {showThinking ? 'Hide' : 'Show'} reasoning ({message.thinking.length} chars)
          </button>
          {showThinking && (
            <div style={{
              padding: '8px 12px',
              background: 'var(--bg-tertiary)',
              borderRadius: '8px',
              fontSize: '13px',
              color: 'var(--text-secondary)',
              fontStyle: 'italic',
              borderLeft: '3px solid var(--accent)',
              whiteSpace: 'pre-wrap',
              marginTop: '4px',
            }}>
              {message.thinking}
            </div>
          )}
        </div>
      )}
      <div style={{
        maxWidth: '80%',
        padding: '10px 16px',
        borderRadius: '16px 16px 16px 4px',
        background: 'var(--bg-secondary)',
        border: '1px solid #333',
        fontSize: '14px',
        lineHeight: '1.6',
        whiteSpace: 'pre-wrap',
      }}>
        {message.content || (message.role === 'assistant' ? '...' : '')}
      </div>
    </div>
  );
}
