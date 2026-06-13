'use client';

import { type Dispatch, useCallback } from 'react';

// Minimal shape of actions consumed by this hook
type ApprovalAction = { type: 'SHOW_APPROVAL'; command: null };

interface UseApprovalOptions {
  dispatch: Dispatch<ApprovalAction>;
  pendingApprovalId: string | null;
}

interface UseApprovalResult {
  handleApprove: () => Promise<void>;
  handleReject: () => Promise<void>;
}

/**
 * Manages command approval/rejection POSTs to /api/approve and dispatches
 * the corresponding store action to close the modal.
 */
export function useApproval({
  dispatch,
  pendingApprovalId,
}: UseApprovalOptions): UseApprovalResult {
  const postApproval = useCallback(
    async (approved: boolean) => {
      if (pendingApprovalId) {
        try {
          await fetch('/api/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: pendingApprovalId, approved }),
          });
        } catch {
          // Keep modal open on failure so the user can retry
          return;
        }
      }
      dispatch({ type: 'SHOW_APPROVAL', command: null });
    },
    [dispatch, pendingApprovalId]
  );

  const handleApprove = useCallback(() => postApproval(true), [postApproval]);
  const handleReject = useCallback(() => postApproval(false), [postApproval]);

  return { handleApprove, handleReject };
}
