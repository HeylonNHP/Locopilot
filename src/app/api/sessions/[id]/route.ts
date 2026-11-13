// GET /api/sessions/[id] - get session messages
// PATCH /api/sessions/[id] - set the conversation's model selection
// DELETE /api/sessions/[id] - delete a session
import { type NextRequest, NextResponse } from 'next/server';

import { enqueueSessionOperation } from '@/app/lib/sessionWriteQueue';
import {
  deleteSession,
  listSessions,
  loadSessionMessages,
  sessionExists,
  updateSessionSelection,
} from '@/services/history';
import { validateSessionSelection } from '@/services/sessionSelection';
import { removeOutputsForSession } from '@/tools/runCommandOutputStore';

export const dynamic = 'force-dynamic';
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
    const lastTokenStats = {
      promptEvalCount: session.last_prompt_eval_count,
      evalCount: session.last_eval_count,
      totalTokens: session.last_total_tokens,
    };
    return NextResponse.json({ session, messages, estimatedTokens, lastTokenStats });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to load session: ${message}` }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const sessionId = Number(id);
    if (Number.isNaN(sessionId)) {
      return NextResponse.json({ error: 'Invalid session ID. Must be a number.' }, { status: 400 });
    }

    if (!sessionExists(sessionId)) {
      return NextResponse.json(
        { error: `Session with id ${sessionId} not found.` },
        { status: 404 }
      );
    }

    const selection = validateSessionSelection(await request.json());
    if (typeof selection === 'string') {
      return NextResponse.json({ error: selection }, { status: 400 });
    }

    // Queued alongside the session's message writes so the selection cannot
    // land in the middle of one. The existence check is repeated inside the
    // queue: the conversation can be deleted while this request waits its
    // turn.
    await enqueueSessionOperation(sessionId, () => {
      if (!sessionExists(sessionId)) return;
      updateSessionSelection(sessionId, selection);
    });

    return NextResponse.json({ success: true, selection });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to update the session's model: ${message}` },
      { status: 500 }
    );
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
    // The command output the session produced goes with it: an artifact of
    // a conversation the user threw away must not outlive it.
    removeOutputsForSession(sessionId);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to delete session: ${message}` }, { status: 500 });
  }
}
