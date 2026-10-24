'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ToolCallArguments } from '@/tools/tools';

import { useClickOutsideEscape } from '@/app/hooks/useClickOutsideEscape';
import { useDialogFocus } from '@/app/hooks/useDialogFocus';

import './ApprovalModal.scss';

interface Props {
  command: { name: string; args: ToolCallArguments; toolCallName?: string };
  /** True while the approve/reject POST is in flight. */
  isSubmitting?: boolean;
  /** Server-side failure from the POST, shown inside the dialog. */
  error?: string | null;
  onApprove: () => void;
  onReject: () => void;
}

function formatArgs(
  args: ToolCallArguments,
  commandName?: string,
  toolCallName?: string
): React.ReactNode {
  if (commandName === 'mcp_call') {
    // Render the namespaced MCP tool as a friendly header, then a
    // key/value list of the arguments (not raw JSON).  Cast to a
    // generic record so we can iterate arbitrary key/value pairs
    // regardless of the ToolCallArguments field layout.
    const argsRecord = args as Record<string, unknown>;
    // Render the namespaced MCP tool as a friendly header, then a
    // key/value list of the arguments (not raw JSON).
    return (
      <>
        {toolCallName ? (
          <div className="modal-mcp-tool-name">
            Allow MCP tool <strong>{toolCallName}</strong>?
          </div>
        ) : null}
        <div className="modal-args-list">
          {argsRecord && typeof argsRecord === 'object' ? (
            Object.entries(argsRecord).map(([key, value]) => (
              <div key={key} className="modal-args-row">
                <span className="modal-args-key">{key}:</span>
                <span className="modal-args-value">
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </span>
              </div>
            ))
          ) : (
            <div className="modal-args-row">
              <span className="modal-args-value">{String(argsRecord ?? '')}</span>
            </div>
          )}
        </div>
      </>
    );
  }
  // Default (run_command and any other tool): show raw args.
  return typeof args === 'string' ? args : JSON.stringify(args, null, 2);
}

/**
 * Blocks the turn until the user allows or rejects a tool call. Rendered in a
 * portal so it is never clipped by the shell's `overflow: hidden`, and behaves
 * like a real dialog: labelled, focus-trapped, Escape/backdrop rejectable
 * (except mid-POST), and it restores focus on close.
 */
export default function ApprovalModal({
  command,
  isSubmitting = false,
  error = null,
  onApprove,
  onReject,
}: Props) {
  const isMcpCall = command.name === 'mcp_call';
  const titleId = useId();
  const rejectRef = useRef<HTMLButtonElement>(null);
  // The dialog body lives in a portal, which has no meaning on the server.
  // Rendering nothing until mounted keeps the component safe to place in any
  // tree (and keeps the focus effect's target present when it runs).
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Escape and backdrop dismissal both reject. Guarded so an in-flight POST
  // cannot be dismissed out from under the user (the request would still
  // resolve server-side, but the outcome would be invisible).
  const handleDismiss = useCallback(() => {
    if (isSubmitting) return;
    onReject();
  }, [isSubmitting, onReject]);

  const panelRef = useDialogFocus<HTMLDivElement>({
    initialFocusRef: rejectRef,
    enabled: isMounted,
  });
  useClickOutsideEscape(panelRef, { isOpen: isMounted, onClose: handleDismiss });

  if (!isMounted) return null;

  return createPortal(
    <div className="modal-overlay">
      <div
        ref={panelRef}
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={isSubmitting || undefined}
      >
        <h3 id={titleId} className="modal-title">
          {isMcpCall && command.toolCallName
            ? `Allow MCP tool ${command.toolCallName}?`
            : 'Allow this command to run?'}
        </h3>
        <div className="modal-command-box">
          {isMcpCall ? (
            formatArgs(command.args, command.name, command.toolCallName)
          ) : (
            <div className="modal-command-text">
              {typeof command.args === 'string'
                ? command.args
                : JSON.stringify(command.args, null, 2)}
            </div>
          )}
        </div>
        {error ? (
          <div className="modal-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="modal-actions">
          <button
            ref={rejectRef}
            type="button"
            className="modal-btn-reject"
            onClick={handleDismiss}
            disabled={isSubmitting}
          >
            Reject
          </button>
          <button
            type="button"
            className="modal-btn-approve"
            onClick={onApprove}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Sending…' : 'Allow'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
