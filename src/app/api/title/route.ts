import { type NextRequest, NextResponse } from 'next/server';

import { enqueueSessionRename } from '@/app/lib/sessionWriteQueue';
import { resolveEffectiveNumCtx } from '@/services/capResolver';
import { loadConfig } from '@/services/configManager';
import { listSessions, loadSessionMessages } from '@/services/history';
import { resolveCompactionModel } from '@/services/modelManager';
import { getProviderNumCtx, resolveProviderRequestContext } from '@/services/providerResolver';
import { generateSessionTitle } from '@/services/titleGeneration';

import {
  buildLlmRequestContext,
  type ChatMessage,
  getLlmApiErrorMessage,
  type LlmRequestContext,
} from '../../../services/llm';

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
  const providerId = body.providerId;
  const compactionModel = body.compactionModel;
  const sessionId = body.sessionId;
  const think: boolean | undefined = body.think as boolean | undefined;
  const reasoningEffortRaw: unknown = body.reasoningEffort;
  const reasoningEffort: 'off' | 'low' | 'medium' | 'high' | undefined =
    reasoningEffortRaw === 'off' ||
    reasoningEffortRaw === 'low' ||
    reasoningEffortRaw === 'medium' ||
    reasoningEffortRaw === 'high'
      ? reasoningEffortRaw
      : undefined;

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
    const resolved = resolveProviderRequestContext(
      config,
      typeof providerId === 'string' ? providerId : undefined,
      model as string
    );
    if (resolved) {
      llmRequestContext = resolved.ctx;
    } else {
      // No provider resolved (legacy config or a stale providerId with no
      // model match). Prefer the persisted config baseUrl and fall back to
      // the body value only when config has none — this matches the chat
      // route's precedence and avoids sending config's apiKey to an
      // arbitrary caller-supplied host.
      llmRequestContext = buildLlmRequestContext({
        baseUrl:
          config?.baseUrl?.trim() ||
          (typeof baseUrl === 'string' && baseUrl.trim().length > 0
            ? baseUrl.trim()
            : 'http://localhost:11434'),
        ...(config?.provider ? { provider: config.provider } : {}),
        ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
      });
    }

    // Resolve the effective numCtx against the model's runtime cap. The
    // body numCtx is an explicit per-request override; otherwise the
    // resolved provider's numCtx wins, falling back to the global config
    // value and finally DEFAULT_NUM_CTX. The clamp itself is the server's
    // responsibility.
    const bodyRequested =
      typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0
        ? Math.floor(numCtx)
        : null;
    const providerRequested = resolved
      ? getProviderNumCtx(resolved.provider, config?.numCtx)
      : config?.numCtx && Number.isFinite(config.numCtx) && config.numCtx > 0
        ? Math.floor(config.numCtx)
        : null;
    const requested = bodyRequested ?? providerRequested ?? 0;
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
      typeof think === 'boolean' ? think : undefined,
      reasoningEffort
    );

    await enqueueSessionRename(parsedSessionId, title);

    return NextResponse.json({
      sessionId: parsedSessionId,
      title,
    });
  } catch (err) {
    const fallbackMessage = err instanceof Error ? err.message : 'Unknown error';
    const message = await getLlmApiErrorMessage(llmRequestContext, err).catch(
      () => fallbackMessage
    );

    return NextResponse.json({ error: message || fallbackMessage }, { status: 500 });
  }
}
