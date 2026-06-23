import { type NextRequest, NextResponse } from 'next/server';

import { enqueueSessionRename } from '@/app/lib/sessionWriteQueue';
import { DEFAULT_NUM_CTX } from '@/constants';
import { loadConfig } from '@/services/configManager';
import { listSessions, loadSessionMessages } from '@/services/history';
import { resolveCompactionModel } from '@/services/modelManager';
import { generateSessionTitle } from '@/services/titleGeneration';

import { type ChatMessage, configureLlmAdapterAndAuth, getLlmApiErrorMessage } from '../../../services/llm';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const model = body.model;
  const numCtx = body.numCtx;
  const baseUrl = body.baseUrl;
  const compactionModel = body.compactionModel;
  const sessionId = body.sessionId;
  const think: boolean | undefined = body.think as boolean | undefined;

  if (typeof model !== 'string' || !model.trim()) {
    return NextResponse.json({ error: 'Model name is required.' }, { status: 400 });
  }

  const parsedSessionId =
    typeof sessionId === 'number' && Number.isFinite(sessionId) && sessionId > 0 ? sessionId : null;
  if (!parsedSessionId) {
    return NextResponse.json(
      { error: 'This conversation does not have a saved session yet.' },
      { status: 400 }
    );
  }

  const session = listSessions().find((candidate) => candidate.id === parsedSessionId);
  if (!session) {
    return NextResponse.json(
      { error: `Session with id ${parsedSessionId} not found.` },
      { status: 404 }
    );
  }

  // Load messages from the database — non-system messages only
  const conversationMessages = loadSessionMessages(parsedSessionId).filter(
    (m): m is ChatMessage => m.role !== 'subagent_log'
  );

  if (conversationMessages.length <= 1) {
    return NextResponse.json(
      { error: 'Not enough conversation history to generate a title yet.' },
      { status: 400 }
    );
  }

  try {
    const config = await loadConfig();
    configureLlmAdapterAndAuth(config?.provider, config?.apiKey);
    const effectiveBaseUrl =
      typeof baseUrl === 'string' && baseUrl.trim().length > 0
        ? baseUrl.trim()
        : config?.baseUrl?.trim() || 'http://localhost:11434';
    const effectiveNumCtx =
      typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0
        ? Math.floor(numCtx)
        : config?.numCtx && Number.isFinite(config.numCtx) && config.numCtx > 0
          ? Math.floor(config.numCtx)
          : DEFAULT_NUM_CTX;
    const effectiveCompactionModel = resolveCompactionModel(
      typeof compactionModel === 'string' ? compactionModel : config?.compactionModel,
      model.trim()
    );

    const title = await generateSessionTitle(
      effectiveBaseUrl,
      effectiveCompactionModel,
      conversationMessages,
      effectiveNumCtx,
      undefined,
      typeof think === 'boolean' ? think : undefined
    );

    await enqueueSessionRename(parsedSessionId, title);

    return NextResponse.json({
      sessionId: parsedSessionId,
      title,
    });
  } catch (err) {
    const fallbackMessage = err instanceof Error ? err.message : 'Unknown error';
    const message = await getLlmApiErrorMessage(err).catch(() => fallbackMessage);

    return NextResponse.json({ error: message || fallbackMessage }, { status: 500 });
  }
}
