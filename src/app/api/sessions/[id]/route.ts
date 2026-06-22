// GET /api/sessions/[id] - get session messages
// DELETE /api/sessions/[id] - delete a session
import { type NextRequest, NextResponse } from 'next/server';

import { deleteSession, listSessions, loadSessionMessages } from '@/services/history';
import { type ChatMessage } from '@/services/llm';
import { countMessagesTokens } from '@/services/tokenizer';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const sessionId = Number(id);
    if (Number.isNaN(sessionId)) {
      return NextResponse.json({ error: 'Invalid session ID. Must be a number.' }, { status: 400 });
    }

    // Verify session exists
    const sessions = listSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      return NextResponse.json(
        { error: `Session with id ${sessionId} not found.` },
        { status: 404 }
      );
    }

    const messages = loadSessionMessages(sessionId);
    const messagesForCounting = messages.filter((m): m is ChatMessage => m.role !== 'subagent_log');
    const estimatedTokens =
      messagesForCounting.length > 0 ? countMessagesTokens(messagesForCounting, session.model) : 0;
    return NextResponse.json({ session, messages, estimatedTokens });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to load session: ${message}` }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const sessionId = Number(id);
    if (Number.isNaN(sessionId)) {
      return NextResponse.json({ error: 'Invalid session ID. Must be a number.' }, { status: 400 });
    }

    // Verify session exists
    const sessions = listSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) {
      return NextResponse.json(
        { error: `Session with id ${sessionId} not found.` },
        { status: 404 }
      );
    }

    deleteSession(sessionId);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to delete session: ${message}` }, { status: 500 });
  }
}
