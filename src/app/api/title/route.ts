import { type NextRequest, NextResponse } from 'next/server';

import { enqueueSessionRename } from '@/app/lib/sessionWriteQueue';
import { DEFAULT_NUM_CTX } from '@/constants';
import { DEFAULT_OLLAMA_BASE_URL } from '@/services/configDefaults';
import { loadConfig } from '@/services/configManager';
import { resolveNumCtx } from '@/services/contextWindow/resolveNumCtx';
import { listSessions, loadSessionMessages } from '@/services/history';
import {
  buildLlmRequestContext,
  type ChatMessage,
  getLlmApiErrorMessage,
  type LlmRequestContext,
} from '@/services/llm';
import { resolveCompactionModel } from '@/services/modelManager';
import { resolveProviderRequestContext } from '@/services/providerResolver';
import { generateSessionTitle } from '@/services/titleGeneration';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const model = body.model;
  const baseUrl = body.baseUrl;
  const providerId = body.providerId;
  const compactionModel = body.compactionModel;
  const compactionProviderId = body.compactionProviderId;
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
        : DEFAULT_OLLAMA_BASE_URL,
  });
  try {
    const config = await loadConfig();
    const resolved = resolveProviderRequestContext(
      config,
      typeof providerId === 'string' ? providerId : undefined,
      model as string
    );
    // No provider resolved (e.g. a stale providerId with no model
    // match). Fall back to the body baseUrl or the default Ollama URL.
    // The fallback is UNauthenticated — never pair a provider's apiKey
    // with the body baseUrl. A stale providerId on a multi-provider
    // config could otherwise leak the user's API key to a caller-
    // supplied host.
    llmRequestContext = resolved
      ? resolved.ctx
      : buildLlmRequestContext({
          baseUrl:
            typeof baseUrl === 'string' && baseUrl.trim().length > 0
              ? baseUrl.trim()
              : DEFAULT_OLLAMA_BASE_URL,
        });

    const effectiveCompactionModel = resolveCompactionModel(
      typeof compactionModel === 'string' ? compactionModel : config?.compactionModel,
      model.trim()
    );

    // Resolve a separate provider for the compaction LLM call ONLY when
    // the client explicitly supplied a compactionProviderId. This lets
    // the user pick a compaction model from a different provider than
    // the main chat model. When no compactionProviderId is supplied
    // (e.g. "Same as main model", or a legacy client) we MUST use the
    // main resolved context directly. Falling back to model-name
    // resolution here is unsafe: if the active model is not stored as
    // any provider's default `model`, resolveProvider falls back to
    // providers[0], sending the title-generation request to the wrong
    // endpoint (often Ollama localhost) and producing a 404.
    const explicitCompactionProviderId =
      typeof compactionProviderId === 'string' && compactionProviderId.trim().length > 0
        ? compactionProviderId.trim()
        : undefined;
    const compactionResolved = explicitCompactionProviderId
      ? resolveProviderRequestContext(
          config,
          explicitCompactionProviderId,
          effectiveCompactionModel
        )
      : null;
    const compactionLlmRequestContext = compactionResolved?.ctx ?? llmRequestContext;

    // The window for the title call: the saved setting (the provider's own
    // numCtx, else the global one) capped by the TITLE model's own maximum. The
    // request body is not an input. `generateSessionTitle` applies its own,
    // smaller cap on top, so a long title cannot be produced whatever the window.
    const titleWindow = await resolveNumCtx({
      ctx: compactionLlmRequestContext,
      model: effectiveCompactionModel,
      providerNumCtx: (compactionResolved?.provider ?? resolved?.provider)?.numCtx,
      configNumCtx: config?.numCtx,
    });
    const compactionNumCtx = titleWindow.effective ?? DEFAULT_NUM_CTX;

    const title = await generateSessionTitle(
      compactionLlmRequestContext,
      effectiveCompactionModel,
      conversationMessages,
      compactionNumCtx,
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
