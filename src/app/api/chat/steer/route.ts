/**
 * POST /api/chat/steer – Send a steering message to an in-flight turn.
 *
 * Body: { sessionId: number, text: string, target: 'main' | 'subagent', agentId?: string }
 *
 * The chat SSE stream for that session picks the message up at the top of
 * its next tool-call loop iteration (main loop for `target: 'main'`, the
 * currently-running sub-agent's loop for `target: 'subagent'`) and confirms
 * it with a `status` event whose phase is `steer_applied`. A 404 means no
 * turn is streaming for that session — the caller must not treat the
 * message as sent; the client keeps it in the composer.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { requestSteerMessage } from '@/app/lib/steerRegistry';

export const dynamic = 'force-dynamic';

interface SteerBody {
  sessionId?: unknown;
  text?: unknown;
  target?: unknown;
  agentId?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: SteerBody;
  try {
    body = (await req.json()) as SteerBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sessionId = body.sessionId;
  if (typeof sessionId !== 'number' || !Number.isInteger(sessionId)) {
    return NextResponse.json({ error: 'sessionId (integer) is required' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: 'text (non-empty string) is required' }, { status: 400 });
  }

  if (body.target !== 'main' && body.target !== 'subagent') {
    return NextResponse.json(
      { error: 'target must be "main" or "subagent"' },
      { status: 400 }
    );
  }
  const target = body.target;

  const agentId = typeof body.agentId === 'string' && body.agentId.trim() ? body.agentId : undefined;

  const id = requestSteerMessage(sessionId, text, target, agentId);
  if (id === false) {
    return NextResponse.json({ error: 'No streaming turn for that session' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id });
}
