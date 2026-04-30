/**
 * Server-side approval registry.
 *
 * When the AI requests `run_command` and YOLO mode is off, the chat route
 * pauses by registering a pending promise here and sending an
 * `approval_request` SSE event to the client.  The client shows the
 * ApprovalModal, and on Approve/Reject posts to /api/approve which calls
 * `resolveApproval()` to resume the paused route.
 *
 * Note: This relies on module-level singleton state and therefore only works
 * correctly in a single-process deployment, which is exactly what Locopilot
 * is (a local dev tool running `next dev` or a single `next start` process).
 */

const APPROVAL_TIMEOUT_MS = 120_000; // 2 minutes

interface PendingApproval {
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Register a pending approval request.
 * Returns a Promise that resolves to `true` (approved) or `false`
 * (rejected or timed-out after 2 minutes).
 */
export function waitForApproval(requestId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            pendingApprovals.delete(requestId);
            resolve(false); // timeout → auto-reject
        }, APPROVAL_TIMEOUT_MS);

        pendingApprovals.set(requestId, { resolve, timer });
    });
}

/**
 * Resolve a pending approval request.
 * Returns `true` if the requestId was found and resolved, `false` if it had
 * already timed out, been resolved, or never existed (safe to call multiple
 * times — idempotent).
 */
export function resolveApproval(requestId: string, approved: boolean): boolean {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingApprovals.delete(requestId);
    pending.resolve(approved);
    return true;
}
