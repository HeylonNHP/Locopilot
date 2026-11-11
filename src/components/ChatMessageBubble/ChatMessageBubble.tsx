'use client';
import dynamic from 'next/dynamic';
import React, { memo, useEffect, useState } from 'react';

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
  canDelete?: boolean | undefined;
  isDeletingPrompt?: boolean | undefined;
}

/**
 * One message of the conversation on screen.
 *
 * Exported through `memo`: every store update (each streamed chunk, each
 * background flush, each status event) re-renders the page, and without memo
 * that redrew EVERY bubble — so the cost of a chunk grew with the length of
 * the conversation. With the default shallow comparison a bubble redraws only
 * when its own props change. That depends on two things, both pinned by
 * tests/message-memo.test.mjs:
 *   - the reducer replaces only the message that changed and keeps every other
 *     message the SAME object (a reload from the database is the exception:
 *     every bubble redraws once, at the end of a turn);
 *   - MessagesArea passes no prop that is created fresh on every render, and
 *     the delete props only to user bubbles (the only ones that use them).
 * Nothing in here may read the chat context (`useChat`): a context read
 * re-renders the bubble on every update and silently undoes the memo.
 */
function ChatMessageBubble({ message, onDeletePrompt, canDelete, isDeletingPrompt }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const hasThinking = Boolean(message.thinking?.trim());
  const hasContent = Boolean(message.content?.trim());
  // An assistant message that has no text, no reasoning, and no tool calls
  // is an empty placeholder (e.g. persisted by the empty-response recovery
  // path before any real reply arrives). The follow-tool-result bubbles
  // already render the tool output for tool-call carriers, and an empty
  // reply produces an empty "..." box otherwise. In either case we want
  // to render nothing.
  const isEmptyAssistantPlaceholder = message.role === 'assistant' && !hasContent && !hasThinking;

  useEffect(() => {
    if (hasThinking && !hasContent) {
      setShowThinking(true);
    }
  }, [hasThinking, hasContent]);

  // Two-pass rendering: server and initial client render both output the
  // same placeholder (null), so React hydration never sees a mismatch.
  // After mount the client swaps in the real MarkdownMessage.
  //
  // This hook MUST stay above the empty-placeholder return below. A
  // placeholder bubble becomes a real one when the first token arrives
  // (same key, same instance), so calling this hook only in the real branch
  // changes the hook count between renders and React throws "Rendered more
  // hooks than during the previous render" mid-stream.
  const [markdownMounted, setMarkdownMounted] = useState(false);
  useEffect(() => {
    setMarkdownMounted(true);
  }, []);

  if (isEmptyAssistantPlaceholder) {
    return null;
  }

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

export default memo(ChatMessageBubble);
