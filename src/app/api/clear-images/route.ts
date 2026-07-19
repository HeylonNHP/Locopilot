import { type NextRequest, NextResponse } from 'next/server';

import { loadSessionMessages, updateSessionMessages } from '@/services/history';

export const dynamic = 'force-dynamic';

/**
 * POST /api/clear-images
 * Body: { sessionId: number }
 *
 * Strips the `images` array from every message in the given session and
 * persists the cleaned list. Used by the /clear-images slash command to
 * recover a conversation that has overloaded the vision context budget.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const sessionId = body.sessionId;
  const parsedSessionId =
    typeof sessionId === 'number' && Number.isFinite(sessionId) && sessionId > 0 ? sessionId : null;
  if (!parsedSessionId) {
    return NextResponse.json({ error: 'A valid sessionId is required.' }, { status: 400 });
  }

  try {
    const messages = loadSessionMessages(parsedSessionId);
    if (messages.length === 0) {
      return NextResponse.json({ messages: [], removedImages: 0, removedMessages: 0 });
    }

    let removedImages = 0;
    let removedMessages = 0;
    const cleaned = messages.map((m) => {
      if (m.role !== 'subagent_log' && m.images && m.images.length > 0) {
        removedImages += m.images.length;
        removedMessages += 1;
        const { images: _images, ...rest } = m;
        return rest;
      }
      return m;
    });

    if (removedImages > 0) {
      updateSessionMessages(parsedSessionId, cleaned);
    }

    return NextResponse.json({ messages: cleaned, removedImages, removedMessages });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
