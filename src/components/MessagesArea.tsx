'use client';

import type { RefObject } from 'react';

import type { ChatMessage } from '@/app/lib/chatStore';

import ChatMessageBubble from '@/components/ChatMessageBubble';
import { EmptyState } from '@/components/EmptyState';
import { ErrorBanner } from '@/components/ErrorBanner';
import ScrollToLatestButton from '@/components/ScrollToLatestButton';

interface MessagesAreaProps {
  messages: ChatMessage[];
  error: string | null;
  isCurrentSessionStreaming: boolean;
  modelCount: number;
  showScrollToLatest: boolean;
  messagesAreaRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onRetry: () => void;
  onDismissError: () => void;
  onScrollToLatest: (behavior: ScrollBehavior) => void;
  onDeletePrompt?: ((messageId: string | number) => void) | undefined;
}

/**
 * Renders the scrollable message list, the empty state when there are no
 * messages, the error banner, and the scroll-to-latest button.
 */
export function MessagesArea({
  messages,
  error,
  isCurrentSessionStreaming,
  modelCount,
  showScrollToLatest,
  messagesAreaRef,
  messagesEndRef,
  onRetry,
  onDismissError,
  onScrollToLatest,
  onDeletePrompt,
}: MessagesAreaProps) {
  return (
    <div className="messages-shell">
      <div
        ref={messagesAreaRef}
        className={`messages-area ${showScrollToLatest ? 'messages-area--has-scroll-button' : ''}`}
      >
        {messages.length === 0 ? (
          <EmptyState modelCount={modelCount} />
        ) : (
          messages.map((msg, i) => (
            <ChatMessageBubble
              key={msg.id ?? i}
              message={msg}
              onDeletePrompt={onDeletePrompt}
              canDelete={!isCurrentSessionStreaming}
            />
          ))
        )}

        {error && (
          <ErrorBanner
            error={error}
            isRetrying={isCurrentSessionStreaming}
            onRetry={onRetry}
            onDismiss={onDismissError}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      <ScrollToLatestButton
        visible={showScrollToLatest && messages.length > 0}
        onClick={() => onScrollToLatest('smooth')}
      />
    </div>
  );
}
