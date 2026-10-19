'use client';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useClickOutsideEscape } from '@/app/hooks/useClickOutsideEscape';

import './ConfirmDialog.scss';

interface Props {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// Small blocking confirmation dialog for destructive actions. Rendered in a
// portal (like MermaidOverlay) so the mount point in the tree never matters,
// and it reuses the global .modal-overlay / .modal-title / .modal-actions /
// .modal-btn-reject classes from ApprovalModal.scss. Focus starts on Cancel —
// a stray Enter must be a no-op, never a delete.
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  // Click outside the panel (i.e. the backdrop) or Escape cancels.
  useClickOutsideEscape(panelRef, { isOpen: true, onClose: onCancel });

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelBtnRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="modal-overlay">
      <div
        ref={panelRef}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId} className="modal-title">
          {title}
        </h3>
        {message ? <p className="confirm-dialog__message">{message}</p> : null}
        <div className="modal-actions">
          <button ref={cancelBtnRef} type="button" className="modal-btn-reject" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="confirm-dialog__confirm" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
