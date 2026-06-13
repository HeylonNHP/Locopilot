/**
 * Server-side approval registry.
 *
 * When the AI requests a tool that requires user approval (e.g.
 * `run_command` always, or `mcp_call` for tools not on the server's
 * `autoApprove` list), the chat route pauses by registering a pending
 * promise here and sending an `approval_request` SSE event to the
 * client.  The client shows the ApprovalModal, and on Approve/Reject
 * posts to /api/approve which calls `resolveApproval()` to resume the
 * paused route.
 *
 * Phase 2 change:
 *   The pending promise now resolves to an `ApprovalDecision` rather
 *   than a bare boolean. The decision carries an optional
 *   `grantedTools` list so the `mcp_call` flow can scope approval
 *   to a specific namespaced target (e.g. `mcp__github__create_issue`)
 *   while the `run_command` flow can keep using the boolean form.
 *   Both call sites use the same registry; the new field is ignored
 *   by callers that don't need it.
 *
 *   The registry also accepts an optional `risk` hint at registration
 *   time so the modal can render the right icon and label ("Run
 *   command" vs "Call MCP tool" vs "Network"). The chat route
 *   passes this when it knows the tool category; the existing
 *   `run_command` path passes `risk: 'command'` explicitly.
 *
 * Note: This relies on module-level singleton state and therefore only works
 * correctly in a single-process deployment, which is exactly what Locopilot
 * is (a local dev tool running `next dev` or a single `next start` process).
 */

const APPROVAL_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Coarse tool-risk categories. Used to render the right icon and
 * label in the approval modal. Mapped to UI strings in
 * `components/ChatInput` (or wherever the modal lives).
 */
export type ApprovalRisk = 'command' | 'network' | 'file' | 'mcp' | 'other';

export interface ApprovalRequest {
    /**
     * Display name of the tool being requested (e.g. "run_command",
     * "mcp_call"). Shown in the modal as the title.
     */
    toolName: string;
    /**
     * Coarse risk category. Drives the modal's icon + label.
     * Defaults to 'other' if not provided.
     */
    risk?: ApprovalRisk;
    /**
     * Free-form hint shown to the user (e.g. the command being run
     * or the MCP server/tool pair). Rendered verbatim.
     */
    args?: unknown;
}

export interface ApprovalDecision {
    approved: boolean;
    /**
     * If approved, the set of namespaced tool names the user granted
     * permission for. Empty/absent means "approve the immediate call
     * but don't pre-approve future calls" (the existing Phase 1
     * behaviour for `run_command`).
     */
    grantedTools?: string[];
}

interface PendingApproval {
    resolve: (decision: ApprovalDecision) => void;
    timer: ReturnType<typeof setTimeout>;
    request: ApprovalRequest;
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Register a pending approval request.
 * Returns a Promise that resolves to an `ApprovalDecision`. Times out
 * (auto-rejects) after `APPROVAL_TIMEOUT_MS` (2 minutes) — same
 * behaviour as Phase 1.
 */
export function waitForApproval(requestId: string, request: ApprovalRequest = { toolName: 'unknown' }): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
        const timer = setTimeout(() => {
            pendingApprovals.delete(requestId);
            resolve({ approved: false }); // timeout → auto-reject
        }, APPROVAL_TIMEOUT_MS);

        pendingApprovals.set(requestId, { resolve, timer, request });
    });
}

/**
 * Resolve a pending approval request.
 * Returns `true` if the requestId was found and resolved, `false` if it had
 * already timed out, been resolved, or never existed (safe to call multiple
 * times — idempotent).
 *
 * `decision` defaults to `{ approved: false }` for call sites that
 * only need to pass a boolean (e.g. the abort-path cleanup in the
 * chat route). `decision.grantedTools` is only meaningful when
 * `approved: true`.
 */
export function resolveApproval(
    requestId: string,
    decision: ApprovalDecision | boolean = { approved: false },
): boolean {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingApprovals.delete(requestId);
    // Backward-compat: accept a bare boolean.
    const final: ApprovalDecision = typeof decision === 'boolean'
        ? { approved: decision }
        : decision;
    pending.resolve(final);
    return true;
}

/**
 * Read-only accessor for the registered request metadata. Used by
 * `/api/approve` to surface the request's `toolName` / `args` back
 * to the client (e.g. for telemetry or richer modal rendering).
 * Returns `null` if the requestId is unknown.
 */
export function getApprovalRequest(requestId: string): ApprovalRequest | null {
    const pending = pendingApprovals.get(requestId);
    return pending ? pending.request : null;
}
