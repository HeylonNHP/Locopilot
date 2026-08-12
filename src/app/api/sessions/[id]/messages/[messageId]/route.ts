// DELETE /api/sessions/[id]/messages/[messageId] - delete a user prompt and
// all derived messages up to the next user prompt.
import { type NextRequest, NextResponse } from 'next/server';

import { enqueueSessionOperation } from '@/app/lib/sessionWriteQueue';
import { deleteMessagesFrom, sessionExists } from '@/services/history';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> }
): Promise<NextResponse> {
  try {
    const { id, messageId } = await params;
    const sessionId = Number(id);
    const targetMessageId = Number(messageId);

    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      return NextResponse.json(
        { error: 'Invalid session ID. Must be a positive integer.' },
        { status: 400 }
      );
    }
    if (!Number.isSafeInteger(targetMessageId) || targetMessageId <= 0) {
      return NextResponse.json(
        { error: 'Invalid message ID. Must be a positive integer.' },
        { status: 400 }
      );
    }

    if (!sessionExists(sessionId)) {
      return NextResponse.json(
        { error: `Session with id ${sessionId} not found.` },
        { status: 404 }
      );
    }

    const keptMessages = await enqueueSessionOperation(sessionId, () =>
      deleteMessagesFrom(sessionId, targetMessageId)
    );
    return NextResponse.json({ success: true, messages: keptMessages });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
