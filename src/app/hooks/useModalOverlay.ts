'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { useBodyScrollLock } from '@/app/hooks/useBodyScrollLock';
import { useDialogFocus } from '@/app/hooks/useDialogFocus';
import { useRegisterOverlay } from '@/app/hooks/useOverlayStack';

interface UseModalOverlayOptions {
  onClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  trapFocus?: boolean;
  enabled?: boolean;
}

/**
 * Shared overlay contract for the three components that still hand-rolled
 * focus/escape (SettingsModal, ConfirmDialog, MermaidOverlay):
 *  - reference-counted body scroll lock (useBodyScrollLock)
  - LIFO global Escape stack (useRegisterOverlay → `useOverlayStack.ts`)
  - `useDialogFocus` for initial focus, tab trap, and focus restoration
 *
 * `enabled` exists so callers that portal after mount (ApprovalModal pattern)
 * can keep every other hook gated on the same flag.
 */
export function useModalOverlay<T extends HTMLElement = HTMLDivElement>({
  onClose,
  initialFocusRef,
  returnFocusRef,
  trapFocus = true,
  enabled = true,
}: UseModalOverlayOptions): React.RefObject<T | null> {
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  const isEnabled = enabled && isMounted;
  useBodyScrollLock(isEnabled);

  const id = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Re-use the same id-derived runner identity; store in ref to keep stable.
  const stableOnClose = useRef(() => onCloseRef.current());
  useRegisterOverlay(id, stableOnClose.current, isEnabled);

  const panelRef = useDialogFocus<T>({
    initialFocusRef,
    returnFocusRef,
    trapFocus,
    enabled: isEnabled,
  });

  return panelRef;
}
