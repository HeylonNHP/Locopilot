// GET /api/sessions - list all sessions
// POST /api/sessions - create a new session
import { type NextRequest, NextResponse } from 'next/server';

import { loadConfig } from '@/services/configManager';
import { selectionWriteProblem } from '@/services/contextWindow/configProblem';
import { createSession, listSessions, searchSessions } from '@/services/history';
import { resolveCreationSelection, validateSessionSelection } from '@/services/sessionSelection';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim();
    const sessions = q ? searchSessions(q) : listSessions();
    return NextResponse.json({ sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to list sessions: ${message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      name?: string;
      model?: string;
      providerId?: string | null;
      /** The compaction selection — ONE value. */
      compaction?: unknown;
      /** @deprecated the legacy flat compaction model. */
      compactionModel?: string | null;
      /** @deprecated the legacy flat compaction provider. */
      compactionProviderId?: string | null;
      reasoningEffort?: string | null;
      compactionReasoningEffort?: string | null;
    };
    const name = body.name ?? 'New Session';

    if (!body.model) {
      return NextResponse.json(
        { error: 'Model name is required to create a session.' },
        { status: 400 }
      );
    }

    // The conversation is born with the model selection it will run on. A
    // compaction selection that was not sent is "inherit the global default",
    // which is how the server's own resolution reads it everywhere else.
    //
    // The compaction selection is ONE value: a conversation born with a
    // compaction model and no provider that serves it would be born into the
    // state that sends a compaction model to an endpoint that does not have
    // it. `validateSessionSelection` refuses that, rather than repairing it.
    const validated = validateSessionSelection({
      model: body.model,
      providerId: body.providerId,
      compaction: body.compaction,
      compactionModel: body.compactionModel,
      compactionProviderId: body.compactionProviderId,
      reasoningEffort: body.reasoningEffort,
      compactionReasoningEffort: body.compactionReasoningEffort,
    });
    if (typeof validated === 'string') {
      return NextResponse.json({ error: validated }, { status: 400 });
    }

    // Reasoning levels, unlike the compaction model, are PINNED at creation:
    // a level the caller did not send is resolved from the saved defaults and
    // stored, so a later default change does not move an existing
    // conversation. The level itself was validated above; this only supplies
    // the default it inherits.
    const config = await loadConfig().catch(() => null);
    const selection = resolveCreationSelection(validated, {
      reasoningEffort: config?.reasoningEffort,
      compactionReasoningEffort: config?.compactionReasoningEffort,
    });

    // The pair the request NAMES is checked before the conversation exists:
    // a pinned provider must exist and serve the model, and an explicit
    // compaction provider must too. A conversation born pointing at a ghost
    // provider is a conversation the server created and then refuses to run
    // (bug hunt BUG 5). What the request leaves to the defaults is not
    // checked here - the defaults are the owner's configuration, a turn
    // checks them, and a new chat must still open when they are broken.
    const problem = selectionWriteProblem(config, selection, {
      main: selection.providerId !== null,
      compaction: selection.compaction.kind === 'explicit',
    });
    if (problem !== null) {
      return NextResponse.json({ error: problem }, { status: 409 });
    }

    const id = createSession(name, selection);
    const sessions = listSessions();
    const session = sessions.find((s) => s.id === id);

    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to create session: ${message}` }, { status: 500 });
  }
}
