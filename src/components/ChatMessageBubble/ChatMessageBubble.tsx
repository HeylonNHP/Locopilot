'use client';
import dynamic from 'next/dynamic';
import React, { useEffect, useState } from 'react';

import { type ChatMessage } from '@/app/lib/chatStore';

import { CopyMarkdownButton } from './CopyMarkdownButton';
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary';
import { SubagentLogBubble } from './SubagentLogBubble';
import { SystemMessageBubble } from './SystemMessageBubble';
import { ToolMessageBubble } from './ToolMessageBubble';
import { UserMessageBubble } from './UserMessageBubble';

import './ChatMessageBubble.scss';

const MarkdownMessage = dynamic(() => import('@/components/MarkdownMessage'), {
  ssr: false,
  loading: () => null,
});

interface Props {
  message: ChatMessage;
  onDeletePrompt?: ((messageId: number) => void) | undefined;
  canDelete?: boolean;
  isDeletingPrompt?: boolean | undefined;
}

export default function ChatMessageBubble({
  message,
  onDeletePrompt,
  canDelete,
  isDeletingPrompt,
}: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const hasThinking = Boolean(message.thinking?.trim());
  const hasContent = Boolean(message.content?.trim());
  // An assistant message that has no text, no reasoning, and no tool calls
  // is an empty placeholder (e.g. persisted by the empty-response recovery
  // path before any real reply arrives). The follow-tool-result bubbles
  // already render the tool output for tool-call carriers, and an empty
  // reply produces an empty "..." box otherwise. In either case we want
  // to render nothing.
  const isEmptyAssistantPlaceholder =
    message.role === 'assistant' && !hasContent && !hasThinking;

  useEffect(() => {
    if (hasThinking && !hasContent) {
      setShowThinking(true);
    }
  }, [hasThinking, hasContent]);

  if (isEmptyAssistantPlaceholder) {
    return null;
  }

  // Two-pass rendering: server and initial client render both output the
  // same placeholder (null), so React hydration never sees a mismatch.
  // After mount the client swaps in the real MarkdownMessage.
  const [markdownMounted, setMarkdownMounted] = useState(false);
  useEffect(() => {
    setMarkdownMounted(true);
  }, []);

  switch (message.role) {
    case 'user': {
      return (
        <UserMessageBubble
          message={message}
          onDelete={
            canDelete && !isDeletingPrompt && onDeletePrompt && typeof message.id === 'number'
              ? () => onDeletePrompt(message.id as number)
              : undefined
          }
          disabled={!canDelete || isDeletingPrompt}
        />
      );
    }
    case 'tool': {
      return <ToolMessageBubble message={message} />;
    }
    case 'system': {
      return <SystemMessageBubble message={message} />;
    }
    case 'subagent_log': {
      return <SubagentLogBubble message={message} />;
    }
    case 'assistant': {
      return (
        <div className="bubble-ai-wrap">
          <CopyMarkdownButton content={message.content ?? ''} disabled={!hasContent} />
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
                  {markdownMounted ? (
                    <MarkdownErrorBoundary>
                      <MarkdownMessage
                        source={message.thinking ?? ''}
                        className="markdown-message--thinking"
                      />
                    </MarkdownErrorBoundary>
                  ) : (
                    <div className="markdown-message--thinking" style={{ minHeight: '1.5em' }} />
                  )}
                </div>
              )}
            </div>
          )}
          {hasContent || !hasThinking || !showThinking ? (
            <div
              onClick={
                hasThinking && !hasContent ? () => setShowThinking((prev) => !prev) : undefined
              }
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
              title={
                hasThinking && !hasContent
                  ? showThinking
                    ? 'Hide reasoning'
                    : 'Show reasoning'
                  : undefined
              }
              className={`bubble-ai-msg${hasThinking && !hasContent ? ' cursor-pointer' : ''}`}
            >
              {hasContent || message.role !== 'assistant' ? (
                markdownMounted ? (
                  <MarkdownErrorBoundary>
                    <MarkdownMessage source={message.content} />
                  </MarkdownErrorBoundary>
                ) : (
                  <div style={{ minHeight: '1.5em' }} />
                )
              ) : (
                '...'
              )}
            </div>
          ) : null}
        </div>
      );
    }
  }
}
