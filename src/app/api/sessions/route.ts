// GET /api/sessions - list all sessions
// POST /api/sessions - create a new session
import { type NextRequest, NextResponse } from 'next/server';

import { createSession, listSessions, searchSessions } from '@/services/history';

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
    const body = (await request.json()) as { name?: string; model?: string };
    const name = body.name ?? 'New Session';
    const model = body.model ?? '';

    if (!model) {
      return NextResponse.json(
        { error: 'Model name is required to create a session.' },
        { status: 400 }
      );
    }

    const id = createSession(name, model);
    const sessions = listSessions();
    const session = sessions.find((s) => s.id === id);

    return NextResponse.json({ session }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to create session: ${message}` }, { status: 500 });
  }
}
