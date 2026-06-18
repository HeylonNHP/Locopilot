'use client';

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

interface UseScrollManagerOptions {
  /** Reactive message list — used as an effect dependency to trigger scroll. */
  messages: readonly unknown[];
  /** Current session ID — used to detect session switches and force-scroll. */
  currentSessionId: number | null;
  /** True while the current session is receiving a streaming response. */
  isStreaming?: boolean;
}

interface UseScrollManagerResult {
  showScrollToLatest: boolean;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  messagesAreaRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
}

/**
 * Manages scroll position within the messages area.
 *
 * - Tracks whether the user is at the bottom using a synchronous scroll
 *   listener (throttled with requestAnimationFrame). The bottom threshold
 *   includes the container's bottom padding so the floating "Latest" button
 *   does not prevent re-anchoring.
 * - Auto-scrolls when new messages arrive, but only if the user is already
 *   near the bottom or the session just switched.
 * - Uses instant scrolling while a stream is active so fast chunk updates
 *   don't fall behind smooth animations; uses smooth scrolling otherwise.
 * - Exposes `showScrollToLatest` to drive the scroll-to-bottom button.
 */
export function useScrollManager({
  messages,
  currentSessionId,
  isStreaming = false,
}: UseScrollManagerOptions): UseScrollManagerResult {
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const messagesAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const previousSessionIdRef = useRef<number | null | undefined>(undefined);
  const rafIdRef = useRef<number | null>(null);

  /**
   * Computes the distance from the absolute bottom of the scrollable content
   * that should still be considered "at the bottom". This must cover the
   * container's bottom padding (which grows when the scroll-to-latest button
   * is visible) plus a small comfort margin so the most recent message stays
   * in view.
   */
  const getBottomThreshold = useCallback(() => {
    const container = messagesAreaRef.current;
    if (!container) return 32;
    const paddingBottom = Number.parseFloat(getComputedStyle(container).paddingBottom || '0');
    // Threshold = padding + 32px buffer. The padding is ~16px normally and
    // ~96px when the scroll-to-latest button is shown, so this keeps the
    // anchor region consistent with the visible layout.
    return Math.max(32, paddingBottom + 32);
  }, []);

  const checkAtBottom = useCallback(() => {
    const container = messagesAreaRef.current;
    if (!container) return true;

    const threshold = getBottomThreshold();
    const maxScroll = container.scrollHeight - container.clientHeight;
    const distanceFromBottom = maxScroll - container.scrollTop;
    const isAtBottom = distanceFromBottom <= threshold;

    isAtBottomRef.current = isAtBottom;
    const isScrollable = container.scrollHeight > container.clientHeight + 1;
    setShowScrollToLatest(!isAtBottom && isScrollable);

    return isAtBottom;
  }, [getBottomThreshold]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  // Keep the bottom state in sync with actual user scrolling. Using a scroll
  // listener (throttled with rAF) is more responsive than IntersectionObserver
  // during fast streams, and lets us include the dynamic bottom padding in the
  // "at bottom" calculation.
  useEffect(() => {
    const container = messagesAreaRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        checkAtBottom();
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    // Initialize state for the initial render / restored session.
    handleScroll();

    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [checkAtBottom]);

  // Auto-scroll when messages change, unless the user has intentionally scrolled
  // up in the current session. Always scroll on session switch. Fire a deferred
  // second scroll to handle markdown/image layout settling after load.
  useEffect(() => {
    const sessionChanged = previousSessionIdRef.current !== currentSessionId;

    if (!sessionChanged && !isAtBottomRef.current) {
      return;
    }

    const behavior = isStreaming ? 'auto' : 'smooth';
    scrollToLatest(behavior);
    const timer = setTimeout(() => scrollToLatest(behavior), 120);
    previousSessionIdRef.current = currentSessionId;

    return () => clearTimeout(timer);
  }, [messages, currentSessionId, isStreaming, scrollToLatest]);

  return { showScrollToLatest, scrollToLatest, messagesAreaRef, messagesEndRef };
}
