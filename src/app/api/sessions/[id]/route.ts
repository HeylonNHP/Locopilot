// GET /api/sessions/[id] - get session messages
// PATCH /api/sessions/[id] - set the conversation's model selection
// DELETE /api/sessions/[id] - delete a session
import { type NextRequest, NextResponse } from 'next/server';

import { enqueueSessionOperation } from '@/app/lib/sessionWriteQueue';
import {
  deleteSession,
  getSessionSelection,
  listSessions,
  loadSessionMessages,
  sessionExists,
  updateSessionSelection,
} from '@/services/history';
import {
  mergeSessionSelection,
  type SessionSelection,
  validateSessionSelectionPatch,
} from '@/services/sessionSelection';
import { removeOutputsForSession } from '@/tools/runCommandOutputStore';

export const dynamic = 'force-dynamic';
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
    const estimatedTokens = messages.length > 0 ? countMessagesTokens(messages, session.model) : 0;
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

    const patch = validateSessionSelectionPatch(await request.json());
    if (typeof patch === 'string') {
      return NextResponse.json({ error: patch }, { status: 400 });
    }

    // Queued alongside the session's message writes so the selection cannot
    // land in the middle of one. The existence check is repeated inside the
    // queue: the conversation can be deleted while this request waits its
    // turn.
    //
    // The patch is merged onto the row as it is at WRITE time, not onto the
    // copy the request happened to carry: a control writes only the fields it
    // edited, so an older tab cannot erase a field another tab just changed.
    const selection = await enqueueSessionOperation<SessionSelection | null>(sessionId, () => {
      if (!sessionExists(sessionId)) return null;
      const current = getSessionSelection(sessionId);
      if (!current) return null;
      const merged = mergeSessionSelection(current, patch);
      updateSessionSelection(sessionId, merged);
      return merged;
    });

    if (selection === null) {
      return NextResponse.json(
        { error: `Session with id ${sessionId} not found.` },
        { status: 404 }
      );
    }

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
