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
        : 'http://localhost:11434',
  });
  try {
    const config = await loadConfig();
    const resolved = resolveProviderRequestContext(
      config,
      typeof providerId === 'string' ? providerId : undefined,
      model as string
    );
    // No provider resolved (legacy config or a stale providerId with no
    // model match). Prefer the persisted config baseUrl and fall back to
    // the body value only when config has none. The fallback is
    // UNauthenticated — never pair config.apiKey with the body baseUrl.
    // A stale providerId on a multi-provider config could otherwise leak
    // the user's API key to a caller-supplied host. Matches the chat
    // route's precedence exactly.
    llmRequestContext = resolved
      ? resolved.ctx
      : buildLlmRequestContext({
          baseUrl:
            config?.baseUrl?.trim() ||
            (typeof baseUrl === 'string' && baseUrl.trim().length > 0
              ? baseUrl.trim()
              : 'http://localhost:11434'),
        });

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

    // Resolve a separate provider for the compaction LLM call when the
    // client supplied a compactionProviderId. This lets the user pick a
    // compaction model from a different provider than the main chat
    // model. When no compactionProviderId is supplied (e.g. "Same as main
    // model", or a legacy client) we fall back to the main resolved
    // context so today's behavior is preserved.
    const compactionResolved = resolveProviderRequestContext(
      config,
      typeof compactionProviderId === 'string' ? compactionProviderId : undefined,
      effectiveCompactionModel
    );
    const compactionLlmRequestContext = compactionResolved?.ctx ?? llmRequestContext;

    // numCtx for the compaction LLM call. When a compaction provider
    // resolved, prefer ITS numCtx so a per-provider context limit (e.g.
    // NVIDIA 300000 vs Ollama default) is honored. Otherwise the same
    // main numCtx is used.
    const compactionNumCtx = compactionResolved
      ? getProviderNumCtx(compactionResolved.provider, config?.numCtx)
      : effectiveNumCtx;

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
