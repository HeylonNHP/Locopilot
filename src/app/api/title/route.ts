import { type NextRequest, NextResponse } from 'next/server';

import { enqueueSessionRename } from '@/app/lib/sessionWriteQueue';
import { resolveCompactionSelection } from '@/services/compactionSelection';
import { DEFAULT_OLLAMA_BASE_URL } from '@/services/configDefaults';
import { readConfig } from '@/services/configManager';
import { requestProblemFor, requireWindow } from '@/services/contextWindow/configProblem';
import { resolveNumCtx } from '@/services/contextWindow/resolveNumCtx';
import { listSessions, loadSessionMessages } from '@/services/history';
import {
  buildLlmRequestContext,
  getLlmApiErrorMessage,
  type LlmRequestContext,
} from '@/services/llm';
import { resolveProviderRequestContext } from '@/services/providerResolver';
import { compactionSelectionFromPayload } from '@/services/sessionSelection';
import { generateSessionTitle } from '@/services/titleGeneration';
import { isReasoningEffort, type ReasoningEffort } from '@/types/chatConfig';

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
  // The provider id is normalised the way the preflight normalises it
  // (`requestProblemFor`): trimmed, and a blank id means "no id". The gate
  // and the call must read the SAME id, or they disagree about which
  // provider the title call runs on.
  const providerId: string | undefined =
    typeof body.providerId === 'string' && body.providerId.trim()
      ? body.providerId.trim()
      : undefined;
  // The conversation's own compaction selection — ONE value. The LEGACY flat
  // pair is still read, for a tab that was open before the change.
  const compactionPayload = {
    compaction: body.compaction,
    compactionModel: body.compactionModel,
    compactionProviderId: body.compactionProviderId,
  };
  const sessionId = body.sessionId;
  const think: boolean | undefined = body.think as boolean | undefined;
  const reasoningEffortRaw: unknown = body.reasoningEffort;
  const compactionReasoningEffortRaw: unknown = body.compactionReasoningEffort;
  // Title generation runs the COMPACTION model, so the compaction level is
  // the one that applies. The main field is kept as a legacy fallback for a
  // client that has not been updated yet.
  const reasoningEffort: ReasoningEffort | undefined = isReasoningEffort(
    compactionReasoningEffortRaw
  )
    ? compactionReasoningEffortRaw
    : isReasoningEffort(reasoningEffortRaw)
      ? reasoningEffortRaw
      : undefined;

  if (typeof model !== 'string' || !model.trim()) {
    return NextResponse.json({ error: 'Model name is required.' }, { status: 400 });
  }

  // Refused before any model call when the saved config cannot run this request:
  // unreadable (never overwritten), no model chosen yet, or no context size.
  // See src/services/contextWindow/configProblem.ts.
  const savedConfig = await readConfig();
  if (!savedConfig.ok) {
    return NextResponse.json({ error: savedConfig.message }, { status: 503 });
  }
  const globalCompactionModel = savedConfig.config.compactionModel?.trim() ?? '';
  const parsedCompaction = compactionSelectionFromPayload(
    compactionPayload,
    globalCompactionModel === '' ? model.trim() : globalCompactionModel
  );
  if (!parsedCompaction.ok) {
    return NextResponse.json({ error: parsedCompaction.error }, { status: 400 });
  }
  const sessionCompaction = parsedCompaction.selection;
  const requestProblem = requestProblemFor(savedConfig.config, {
    providerId,
    model,
    compaction: sessionCompaction,
  });
  if (requestProblem !== null) {
    return NextResponse.json({ error: requestProblem }, { status: 409 });
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
  const conversationMessages = loadSessionMessages(parsedSessionId);

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
    const config = savedConfig.config;
    const resolved = resolveProviderRequestContext(config, providerId, model as string);
    // No provider resolved. The preflight refuses a request whose provider
    // id names no configured provider (409), so this is a config that
    // changed in between. Fall back to the body baseUrl or the default
    // Ollama URL. The fallback is UNauthenticated — never pair a provider's
    // apiKey with the body baseUrl. A stale providerId on a multi-provider
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

    // The compaction MODEL and PROVIDER are chosen together, by the ONE
    // shared resolver (`src/services/compactionSelection.ts`): the
    // conversation's own pin, then the global pair
    // (`config.compactionModel` with `config.compactionProviderId`), then
    // the conversation's main model on the main provider. The chat route
    // and the compact route call the same resolver, so the three cannot
    // disagree about which endpoint serves the compaction model.
    //
    // The body carries the conversation's own pin only; the global pair
    // comes from the saved config.
    const compactionSelection = resolveCompactionSelection({
      config,
      mainModel: model.trim(),
      sessionCompaction,
    });
    const effectiveCompactionModel = compactionSelection.model;

    // The provider is resolved BY ID ONLY. Passing no model name is
    // intentional: model-name matching would let a provider id that no
    // longer exists silently become "whatever provider owns that model
    // name" — with that provider's API key — and the title call would go
    // to an endpoint that does not carry the model.
    const compactionResolved =
      compactionSelection.providerId === null
        ? null
        : resolveProviderRequestContext(config, compactionSelection.providerId, undefined);
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
    const compactionNumCtx = requireWindow(titleWindow.effective);

    const title = await generateSessionTitle(
      compactionLlmRequestContext,
      effectiveCompactionModel,
      conversationMessages,
      compactionNumCtx,
      undefined,
      typeof think === 'boolean' ? think : undefined,
      reasoningEffort ?? savedConfig.config.compactionReasoningEffort
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
