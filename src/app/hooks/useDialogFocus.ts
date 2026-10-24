'use client';

import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface UseDialogFocusOptions {
  /** Element to focus on mount. Defaults to the first focusable child. */
  initialFocusRef?: React.RefObject<HTMLElement | null> | undefined;
  /** Element to restore focus to on unmount. Defaults to whatever had focus. */
  returnFocusRef?: React.RefObject<HTMLElement | null> | undefined;
  /** Keep Tab/Shift+Tab inside the panel. Defaults to true. */
  trapFocus?: boolean;
  /**
   * Set false while the panel is not rendered yet (e.g. a portal that only
   * exists after mount) so the effect runs once the ref is populated.
   * Defaults to true.
   */
  enabled?: boolean;
}

/**
 * Dialog focus management: initial focus, focus trap, and focus restoration.
 *
 * A dialog that only renders `role="dialog"` is still broken for keyboard
 * users — Tab walks out into the page behind it and closing it dumps focus on
 * `<body>`. Returns the ref to attach to the panel element.
 */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>({
  initialFocusRef,
  returnFocusRef,
  trapFocus = true,
  enabled = true,
}: UseDialogFocusOptions = {}): React.RefObject<T | null> {
  const panelRef = useRef<T | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const panel = panelRef.current;
    if (!panel) return;

    // Capture both at effect start: on unmount React has already detached the
    // panel, so reading `.current` in the cleanup would be too late.
    const previouslyFocused =
      returnFocusRef?.current ?? (document.activeElement as HTMLElement | null);

    const focusableItems = (): HTMLElement[] =>
      [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true'
      );

    (initialFocusRef?.current ?? focusableItems()[0] ?? panel).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusableItems();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      const active = document.activeElement;
      if (!panel.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    if (trapFocus) {
      // Capture phase so the trap still works when a child stops propagation.
      document.addEventListener('keydown', handleKeyDown, true);
    }

    return () => {
      if (trapFocus) document.removeEventListener('keydown', handleKeyDown, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [initialFocusRef, returnFocusRef, trapFocus, enabled]);

  return panelRef;
}
