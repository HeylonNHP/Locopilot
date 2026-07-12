import { type NextRequest, NextResponse } from 'next/server';

import { enqueueSessionRename } from '@/app/lib/sessionWriteQueue';
import { resolveEffectiveNumCtx } from '@/services/capResolver';
import { loadConfig } from '@/services/configManager';
import { listSessions, loadSessionMessages } from '@/services/history';
import { resolveCompactionModel } from '@/services/modelManager';
import { generateSessionTitle } from '@/services/titleGeneration';

import { buildLlmRequestContext, type ChatMessage, getLlmApiErrorMessage, type LlmRequestContext } from '../../../services/llm';

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

  // Hoisted so the catch at 121 can use it. The inner try sets the real
  // value from the loaded config; this default is the ollama-default
  // fallback if the error fires before config is loaded.
  let llmRequestContext: LlmRequestContext = buildLlmRequestContext({
    baseUrl:
      typeof baseUrl === 'string' && baseUrl.trim().length > 0
        ? baseUrl.trim()
        : 'http://localhost:11434',
  });
  try {
    const config = await loadConfig();
    const effectiveBaseUrl =
      typeof baseUrl === 'string' && baseUrl.trim().length > 0
        ? baseUrl.trim()
        : config?.baseUrl?.trim() || 'http://localhost:11434';
    llmRequestContext = buildLlmRequestContext({
      ...(config?.provider ? { provider: config.provider } : {}),
      ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
      baseUrl: effectiveBaseUrl,
    });
    // Resolve the effective numCtx against the model's runtime
    // cap. The body numCtx is informational; the resolver prefers
    // the persisted config value (the user's authoritative
    // requested cap) and falls back to the body value if config
    // is missing. The clamp is the server's responsibility.
    const bodyRequested = typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0
      ? Math.floor(numCtx)
      : null;
    const configRequested =
      config?.numCtx && Number.isFinite(config.numCtx) && config.numCtx > 0
        ? Math.floor(config.numCtx)
        : null;
    const requested = bodyRequested ?? configRequested ?? 0;
    let effectiveNumCtx = requested;
    if (requested > 0) {
      try {
        const resolved = await resolveEffectiveNumCtx(
          llmRequestContext,
          model as string,
          requested
        );
        effectiveNumCtx = resolved.effective;
      } catch {
        // Resolver is best-effort; fall through with the requested
        // value.
      }
    }
    const effectiveCompactionModel = resolveCompactionModel(
      typeof compactionModel === 'string' ? compactionModel : config?.compactionModel,
      model.trim()
    );

    const title = await generateSessionTitle(
      llmRequestContext,
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
    const message = await getLlmApiErrorMessage(llmRequestContext, err).catch(() => fallbackMessage);

    return NextResponse.json({ error: message || fallbackMessage }, { status: 500 });
  }
}
