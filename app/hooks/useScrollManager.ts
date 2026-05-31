'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseScrollManagerOptions {
  /** Reactive message list — used as an effect dependency to trigger scroll. */
  messages: readonly unknown[];
  /** Current session ID — used to detect session switches and force-scroll. */
  currentSessionId: number | null;
}

interface UseScrollManagerResult {
  showScrollToLatest: boolean;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  messagesAreaRef: React.RefObject<HTMLDivElement>;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

/**
 * Manages scroll position within the messages area.
 *
 * - Tracks whether the user is at the bottom via IntersectionObserver.
 * - Auto-scrolls when new messages arrive (only if already at bottom or the
 *   session just switched).
 * - Exposes `showScrollToLatest` to drive the scroll-to-bottom button.
 */
export function useScrollManager({
  messages,
  currentSessionId,
}: UseScrollManagerOptions): UseScrollManagerResult {
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const messagesAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const previousSessionIdRef = useRef<number | null | undefined>(undefined);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  // IntersectionObserver on the sentinel replaces manual scroll-distance arithmetic.
  // The 32px rootMargin bottom matches the legacy tolerance.
  useEffect(() => {
    const container = messagesAreaRef.current;
    const sentinel = messagesEndRef.current;
    if (!container || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const isAtBottom = entry.isIntersecting;
        isAtBottomRef.current = isAtBottom;
        setShowScrollToLatest(
          !isAtBottom && container.scrollHeight > container.clientHeight + 1,
        );
      },
      { root: container, rootMargin: '0px 0px 32px 0px', threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Auto-scroll when messages change, unless the user has scrolled up in the
  // current session. Always scroll on session switch. Fire a deferred second
  // scroll to handle markdown/image layout settling after load.
  useEffect(() => {
    const sessionChanged = previousSessionIdRef.current !== currentSessionId;

    if (!sessionChanged && !isAtBottomRef.current) {
      return;
    }

    scrollToLatest('smooth');
    const timer = setTimeout(() => scrollToLatest('smooth'), 120);
    previousSessionIdRef.current = currentSessionId;

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, currentSessionId, scrollToLatest]);

  return { showScrollToLatest, scrollToLatest, messagesAreaRef, messagesEndRef };
}
