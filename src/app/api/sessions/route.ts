// GET /api/sessions - list all sessions
// POST /api/sessions - create a new session
import { type NextRequest, NextResponse } from 'next/server';

import { createSession, listSessions, searchSessions } from '@/services/history';
import { validateSessionSelection } from '@/services/sessionSelection';

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
      compactionModel?: string | null;
      compactionProviderId?: string | null;
    };
    const name = body.name ?? 'New Session';

    if (!body.model) {
      return NextResponse.json(
        { error: 'Model name is required to create a session.' },
        { status: 400 }
      );
    }

    // The conversation is born with the model selection it will run on. A
    // compaction model that was not sent is stored as NULL, which means
    // "inherit the global default" — the same thing the server's own
    // resolution does when the request body omits the field.
    const selection = validateSessionSelection({
      model: body.model,
      providerId: body.providerId,
      compactionModel: body.compactionModel,
      compactionProviderId: body.compactionProviderId,
    });
    if (typeof selection === 'string') {
      return NextResponse.json({ error: selection }, { status: 400 });
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
