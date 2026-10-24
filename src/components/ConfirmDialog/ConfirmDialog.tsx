'use client';
import { type ReactNode, useCallback, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useModalOverlay } from '@/app/hooks/useModalOverlay';

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
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  // Backdrop click cancels; Escape is handled by the global overlay stack. A
  // real Enter on Cancel must be a no-op (focus is *there*), never a delete.
  const handleCancel = useCallback(() => onCancel(), [onCancel]);
  const panelRef = useModalOverlay<HTMLDivElement>({
    onClose: handleCancel,
    initialFocusRef: cancelBtnRef,
    // ConfirmDialog is always mounted while open (no SSR portal guard needed:
    // it is only ever rendered after a user interaction).
  });

  return createPortal(
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleCancel();
      }}
    >
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
          <button
            ref={cancelBtnRef}
            type="button"
            className="modal-btn-reject"
            onClick={handleCancel}
          >
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
