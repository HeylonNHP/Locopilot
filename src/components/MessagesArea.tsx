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
  onRetry?: (() => Promise<void> | void) | undefined;
  onDismissError: () => void;
  onScrollToLatest: (behavior: ScrollBehavior) => void;
  onDeletePrompt?: ((messageId: number) => void) | undefined;
  isDeletingPrompt?: boolean | undefined;
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
  isDeletingPrompt,
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
          messages.map((msg, i) => {
            // The bubble is memoised. The delete props change at the start and
            // end of every turn, so they go to user bubbles only (the only ones
            // that use them) — otherwise every assistant bubble would redraw
            // twice per turn for nothing.
            const isUser = msg.role === 'user';
            return (
              <ChatMessageBubble
                key={msg.id ?? i}
                message={msg}
                onDeletePrompt={isUser ? onDeletePrompt : undefined}
                isDeletingPrompt={isUser ? isDeletingPrompt : undefined}
                canDelete={isUser ? !isCurrentSessionStreaming : undefined}
              />
            );
          })
        )}

        {error && <ErrorBanner error={error} onRetry={onRetry} onDismiss={onDismissError} />}

        <div ref={messagesEndRef} />
      </div>

      <ScrollToLatestButton
        visible={showScrollToLatest && messages.length > 0}
        onClick={() => onScrollToLatest('smooth')}
      />
    </div>
  );
}
