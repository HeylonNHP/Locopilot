// GET /api/sessions/[id] - get session messages
// PATCH /api/sessions/[id] - set the conversation's model selection
// DELETE /api/sessions/[id] - delete a session
import { type NextRequest, NextResponse } from 'next/server';

import { enqueueSessionOperation } from '@/app/lib/sessionWriteQueue';
import { loadConfig } from '@/services/configManager';
import { selectionWriteProblem } from '@/services/contextWindow/configProblem';
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
    //
    // The compaction selection is ONE value, so a patch cannot edit one half
    // of the pair: the validator refuses the legacy flat shape that names
    // only one of them, and the new shape has no way to say it.
    //
    // The merged selection is checked as a PAIR before it is written, the
    // same way a turn would check it, so a conversation cannot be saved
    // pointing at a provider that does not exist or does not serve the model
    // and then be refused at its first turn. Only the halves this patch
    // changes are checked (see `selectionWriteProblem`): a conversation
    // already broken by a removed provider must stay editable, or the fix for
    // one half would be refused because of the other.
    const config = await loadConfig().catch(() => null);
    const touchesMain = patch.model !== undefined || patch.providerId !== undefined;
    const result = await enqueueSessionOperation<
      { selection: SessionSelection } | { problem: string } | null
    >(sessionId, () => {
      if (!sessionExists(sessionId)) return null;
      const current = getSessionSelection(sessionId);
      if (!current) return null;
      const merged = mergeSessionSelection(current, patch);
      const problem = selectionWriteProblem(config, merged, {
        main: touchesMain,
        // The compaction pair depends on the main provider unless it names
        // its own, so a change of the main pair re-checks it too.
        compaction:
          patch.compaction !== undefined || (touchesMain && merged.compaction.kind !== 'explicit'),
      });
      if (problem !== null) return { problem };
      updateSessionSelection(sessionId, merged);
      return { selection: merged };
    });

    if (result === null) {
      return NextResponse.json(
        { error: `Session with id ${sessionId} not found.` },
        { status: 404 }
      );
    }
    if ('problem' in result) {
      // 409, like the chat route's own refusal of the same pair: the request
      // is well formed, the saved configuration is what cannot honour it.
      return NextResponse.json({ error: result.problem }, { status: 409 });
    }

    return NextResponse.json({ success: true, selection: result.selection });
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
