/**
 * POST /api/approve – Resolve a pending run_command approval request.
 *
 * Body: { requestId: string, approved: boolean }
 *
 * The corresponding chat SSE stream is waiting on the promise registered in
 * approvalRegistry.  Posting here resumes it (approved = true) or cancels the
 * tool call (approved = false).
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveApproval } from '../../lib/approvalRegistry';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
    let body: Record<string, unknown>;
    try {
        body = await req.json() as Record<string, unknown>;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { requestId, approved } = body;

    if (typeof requestId !== 'string' || !requestId.trim()) {
        return NextResponse.json({ error: 'requestId (string) is required' }, { status: 400 });
    }

    if (typeof approved !== 'boolean') {
        return NextResponse.json({ error: 'approved (boolean) is required' }, { status: 400 });
    }

    const found = resolveApproval(requestId, approved);
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
