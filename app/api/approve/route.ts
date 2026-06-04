/**
 * POST /api/approve – Resolve a pending approval request.
 *
 * Body shapes (all required unless noted):
 *   1. Legacy boolean: { requestId: string, approved: boolean }
 *   2. Typed decision: { requestId: string, decision: { approved: boolean, grantedTools?: string[] } }
 *
 * The corresponding chat SSE stream is waiting on the promise registered in
 * approvalRegistry.  Posting here resumes it (approved = true) or cancels the
 * tool call (approved = false). For the `mcp_call` flow, an approved
 * decision may carry an optional `grantedTools` list (namespaced tool
 * names) that the chat route will record in the per-request approval set.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveApproval, type ApprovalDecision } from '../../lib/approvalRegistry';

export const dynamic = 'force-dynamic';

interface ApproveBody {
    requestId?: unknown;
    approved?: unknown;
    decision?: unknown;
}

function isString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function parseDecision(body: ApproveBody): ApprovalDecision | null {
    // New shape: { decision: { approved, grantedTools? } }
    if (isPlainObject(body.decision)) {
        const d = body.decision as { approved?: unknown; grantedTools?: unknown };
        if (typeof d.approved !== 'boolean') return null;
        const decision: ApprovalDecision = { approved: d.approved };
        if (Array.isArray(d.grantedTools) && d.grantedTools.every((v) => typeof v === 'string')) {
            decision.grantedTools = d.grantedTools as string[];
        }
        return decision;
    }
    // Legacy shape: { approved: boolean }
    if (typeof body.approved === 'boolean') {
        return { approved: body.approved };
    }
    return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    let body: ApproveBody;
    try {
        body = await req.json() as ApproveBody;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!isString(body.requestId)) {
        return NextResponse.json({ error: 'requestId (string) is required' }, { status: 400 });
    }

    const decision = parseDecision(body);
    if (!decision) {
        return NextResponse.json(
            { error: 'Either "decision: { approved }" or legacy "approved" must be a boolean' },
            { status: 400 },
        );
    }

    const found = resolveApproval(body.requestId, decision);
    if (!found) {
        // The request may have already timed out — return 404 so the client
        // knows the action had no effect.
        return NextResponse.json(
            { error: 'No pending approval with that requestId (may have timed out)' },
            { status: 404 },
        );
    }

    return NextResponse.json({ ok: true });
}
