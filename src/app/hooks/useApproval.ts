'use client';

import { type Dispatch, useCallback, useState } from 'react';

import type { ChatAction } from '@/app/lib/chatStore';

interface UseApprovalOptions {
  dispatch: Dispatch<ChatAction>;
  pendingApprovalId: string | null;
}

interface UseApprovalResult {
  handleApprove: () => Promise<void>;
  handleReject: () => Promise<void>;
  /** True while the approval POST is in flight. */
  isSubmitting: boolean;
  /** Server/network failure from the last POST, if any. */
  error: string | null;
}

/**
 * Manages command approval/rejection POSTs to /api/approve and dispatches
 * the corresponding store action to close the modal.
 *
 * The hide dispatch carries `requestId` so the reducer clears the slot of the
 * request that was answered, rather than falling back to whichever session is
 * on screen. Failures keep the modal open with a message instead of silently
 * closing it: `/api/approve` answers 400/404 for an expired id, and `fetch`
 * only rejects on network errors, so a non-ok status must be handled
 * explicitly.
 */
export function useApproval({
  dispatch,
  pendingApprovalId,
}: UseApprovalOptions): UseApprovalResult {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const postApproval = useCallback(
    async (approved: boolean) => {
      if (!pendingApprovalId) {
        setError('This approval request is no longer available. It may have timed out.');
        return;
      }
      setIsSubmitting(true);
      setError(null);
      try {
        const res = await fetch('/api/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: pendingApprovalId, approved }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(
            data.error ?? `Approval failed (HTTP ${res.status}). The request may have expired.`
          );
          return;
        }
        dispatch({ type: 'SHOW_APPROVAL', command: null, requestId: pendingApprovalId });
      } catch {
        setError('Could not reach the server. Check the connection and try again.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [dispatch, pendingApprovalId]
  );

  const handleApprove = useCallback(() => postApproval(true), [postApproval]);
  const handleReject = useCallback(() => postApproval(false), [postApproval]);

  return { handleApprove, handleReject, isSubmitting, error };
}
