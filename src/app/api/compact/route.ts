import { type NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import type { SseEventPayloadMap } from '@/types/sse';

import { debugLog } from '@/app/lib/debugLogger';
import { enqueueSessionWrite } from '@/app/lib/sessionWriteQueue';
import { SSE_KEEPALIVE_MS } from '@/constants';
import { isChatMessage } from '@/services/chatMessageGuard';
import { compactHistory } from '@/services/compact';
import { RECENT_FILES_LOAD_LIMIT } from '@/services/compact/constants';
import {
  COMPACT_FOCUS_MAX_CHARS,
  COMPACT_FOCUS_RAW_MAX_CHARS,
  normaliseCompactionFocus,
} from '@/services/compact/focus';
import { resolveCompactionSelection } from '@/services/compactionSelection';
import { DEFAULT_OLLAMA_BASE_URL } from '@/services/configDefaults';
import { readConfig } from '@/services/configManager';
import { requestProblemFor, requireWindow } from '@/services/contextWindow/configProblem';
import { resolveNumCtx } from '@/services/contextWindow/resolveNumCtx';
import { loadRecentFiles } from '@/services/history';
import {
  buildLlmRequestContext,
  type ChatMessage,
  getLlmApiErrorMessage,
  type LlmRequestContext,
} from '@/services/llm';
import { resolveProviderRequestContext } from '@/services/providerResolver';
import { getAgentWorkingDirectory } from '@/tools/workingDirectory';
import {
  forwardableReasoningEffort,
  isReasoningEffort,
  type ReasoningEffort,
} from '@/types/chatConfig';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const messages = body.messages;
  const model = body.model;
  const baseUrl = body.baseUrl;
  // The provider id is normalised the way the preflight normalises it
  // (`requestProblemFor`): trimmed, and a blank id means "no id". The gate
  // and the call must read the SAME id, or they disagree about which
  // provider the compaction runs on.
  const providerId: string | undefined =
    typeof body.providerId === 'string' && body.providerId.trim()
      ? body.providerId.trim()
      : undefined;
  const compactionModel = body.compactionModel;
  const compactionProviderId = body.compactionProviderId;
  const sessionId = body.sessionId;
  const focusRaw: unknown = body.focus;

  const compactionReasoningEffortRaw: unknown = body.compactionReasoningEffort;
  const compactionReasoningEffort: ReasoningEffort | undefined = isReasoningEffort(
    compactionReasoningEffortRaw
  )
    ? compactionReasoningEffortRaw
    : undefined;

  if (typeof model !== 'string' || !model.trim()) {
    return NextResponse.json({ error: 'Model name is required.' }, { status: 400 });
  }

  // ── The `/compact` focus note ─────────────────────────────────────
  //
  // `focus` is the text the user typed after `/compact`: a note about what the
  // summary should keep. It is OPTIONAL, so an absent field is fine — but a
  // field that is PRESENT and not a string is a client bug, not something to
  // coerce, because the note ends up inside the summariser's system prompt.
  //
  // The length check runs on the NORMALISED note (the form that reaches the
  // prompt) and REJECTS rather than truncates: the tail of the note is where
  // the qualification tends to be — "…but keep the failing test output" — so
  // silently dropping it would lose exactly the part the user cared about.
  if (focusRaw !== undefined && typeof focusRaw !== 'string') {
    return NextResponse.json({ error: 'The compaction focus must be a string.' }, { status: 400 });
  }
  // A cheap RAW-size gate BEFORE normalising. Normalising a 10 MB note means
  // walking every character to strip control characters and collapsing every
  // whitespace run — the whole string is materialised twice — only to send a
  // 400 that was certain from the start. The gate is a generous multiple of the
  // real limit, so it can only reject notes no amount of collapsing could
  // bring under it. Same message, same status.
  if (typeof focusRaw === 'string' && focusRaw.length > COMPACT_FOCUS_RAW_MAX_CHARS) {
    return NextResponse.json(
      {
        error:
          `The compaction focus is ${focusRaw.length} characters long — the limit is ` +
          `${COMPACT_FOCUS_MAX_CHARS}. Shorten the note and try again.`,
      },
      { status: 400 }
    );
  }
  const focus = normaliseCompactionFocus(focusRaw);
  if (focus !== undefined && focus.length > COMPACT_FOCUS_MAX_CHARS) {
    return NextResponse.json(
      {
        error:
          `The compaction focus is ${focus.length} characters long — the limit is ` +
          `${COMPACT_FOCUS_MAX_CHARS}. Shorten the note and try again.`,
      },
      { status: 400 }
    );
  }

  if (!Array.isArray(messages) || messages.length <= 1 || !messages.every(isChatMessage)) {
    return NextResponse.json(
      { error: 'Nothing to compact yet. Continue the conversation and try again.' },
      { status: 400 }
    );
  }

  // Refused before any model call when the saved config cannot run this request:
  // unreadable (never overwritten), no model chosen yet, or no context size.
  // See src/services/contextWindow/configProblem.ts.
  const savedConfig = await readConfig();
  if (!savedConfig.ok) {
    return NextResponse.json({ error: savedConfig.message }, { status: 503 });
  }
  const requestProblem = requestProblemFor(savedConfig.config, {
    providerId,
    model,
    compactionProviderId,
    compactionModel,
  });
  if (requestProblem !== null) {
    return NextResponse.json({ error: requestProblem }, { status: 409 });
  }

  const typedMessages: ChatMessage[] = messages;

  // ── SSE streaming setup ───────────────────────────────────────────
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller): Promise<void> {
      function sendEvent<N extends keyof SseEventPayloadMap>(
        event: N,
        data: SseEventPayloadMap[N]
      ): void {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Client disconnected — safe to ignore
        }
      }

      // A compaction run is dominated by sequential per-message LLM calls
      // (distillation + summarisation), so the stream can sit silent for
      // many seconds between frames — long enough for an idle-timeout proxy
      // or the browser to drop the connection. A comment-only frame is
      // ignored by the SSE parser but keeps the socket warm.
      const keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          // Client disconnected — ignore.
        }
      }, SSE_KEEPALIVE_MS);

      const requestId = randomUUID();
      const logCtx = (): { requestId: string; sessionId?: number } => ({
        requestId,
        ...(typeof sessionId === 'number' && Number.isFinite(sessionId) && sessionId > 0
          ? { sessionId }
          : {}),
      });

      // Hoisted so the catch at 170 can use it. The inner try sets the
      // real value from the loaded config; this default is the
      // ollama-default fallback if the error fires before config loads.
      let llmRequestContext: LlmRequestContext = buildLlmRequestContext({
        baseUrl:
          typeof baseUrl === 'string' && baseUrl.trim().length > 0
            ? baseUrl.trim()
            : DEFAULT_OLLAMA_BASE_URL,
      });
      let effectiveCompactionModel = model as string;
      let compactStartedAt: number | null = null;
      try {
        const config = savedConfig.config;
        const resolved = resolveProviderRequestContext(
          config,
          providerId,
          model as string
        );
        // No provider resolved. The preflight refuses a request whose
        // provider id names no configured provider (409), so this is a
        // config that changed in between. Fall back to the body baseUrl or
        // the default Ollama URL. The fallback is UNauthenticated — never
        // pair a provider's apiKey with the body baseUrl. A stale
        // providerId on a multi-provider config could otherwise leak the
        // user's API key to a caller-supplied host.
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
        // and the title route call the same resolver, so the three cannot
        // disagree about which endpoint serves the compaction model.
        //
        // The body carries the conversation's own pin only; the global pair
        // comes from the saved config.
        const compactionSelection = resolveCompactionSelection({
          config,
          mainModel: model.trim(),
          sessionCompactionModel:
            typeof compactionModel === 'string' ? compactionModel : null,
          sessionCompactionProviderId:
            typeof compactionProviderId === 'string' ? compactionProviderId : null,
        });
        effectiveCompactionModel = compactionSelection.model;

        // The provider is resolved BY ID ONLY. Passing no model name is
        // intentional: model-name matching would let a provider id that no
        // longer exists silently become "whatever provider owns that model
        // name" — with that provider's API key — and the compaction call
        // would go to an endpoint that does not carry the model.
        const compactionResolved =
          compactionSelection.providerId === null
            ? null
            : resolveProviderRequestContext(
                config,
                compactionSelection.providerId,
                undefined
              );
        const compactionLlmRequestContext = compactionResolved?.ctx ?? llmRequestContext;

        // The windows come from the server's saved setting and each model's own
        // maximum; the request body is not an input. The main window is what
        // the next turn runs in (the receipt's overflow check); the compaction
        // window is what the summarising calls are planned against, and the
        // compaction model can have a lower maximum than the main one. When
        // both are the same endpoint and model the probe is shared.
        const [mainWindow, compactionWindow] = await Promise.all([
          resolveNumCtx({
            ctx: llmRequestContext,
            model: model as string,
            providerNumCtx: resolved?.provider.numCtx,
            configNumCtx: config?.numCtx,
          }),
          resolveNumCtx({
            ctx: compactionLlmRequestContext,
            model: effectiveCompactionModel,
            providerNumCtx: (compactionResolved?.provider ?? resolved?.provider)?.numCtx,
            configNumCtx: config?.numCtx,
          }),
        ]);
        const effectiveNumCtx = requireWindow(mainWindow.effective);
        const compactionNumCtx = requireWindow(compactionWindow.effective);

        // Strip system messages before compacting — the system prompt is
        // injected on-the-fly. Sub-agent traces need no handling here: they live
        // on their tool messages, so they are kept with a preserved message and
        // dropped with a summarised one.
        const conversationMessages: ChatMessage[] = typedMessages.filter(
          (m) => m.role !== 'system'
        );

        debugLog.diagnostic({
          layer: 'route',
          phase: 'compaction_start',
          ...logCtx(),
          provider: compactionLlmRequestContext.provider,
          model: effectiveCompactionModel,
          baseUrl: compactionLlmRequestContext.baseUrl,
          messageCount: conversationMessages.length,
          numCtx: compactionNumCtx,
        });
        compactStartedAt = Date.now();

        // The session whose recent files are re-attached after the compaction,
        // when there is one (a `/compact` of an unsaved conversation has no
        // session id and simply gets no stub). Parsed here because the same
        // value decides whether the compacted history is persisted below.
        const parsedSessionId =
          typeof sessionId === 'number' && Number.isFinite(sessionId) && sessionId > 0
            ? sessionId
            : null;
        // A FEW more rows than the stub shows: a row whose file has since been
        // deleted or moved is unreadable, and loading exactly as many rows as
        // the stub names would let one dangling row cost a slot.
        const recentFiles =
          parsedSessionId === null
            ? undefined
            : loadRecentFiles(parsedSessionId, RECENT_FILES_LOAD_LIMIT);

        const result = await compactHistory({
          ctx: compactionLlmRequestContext,
          model: effectiveCompactionModel,
          messages: conversationMessages,
          numCtx: compactionNumCtx,
          onProgress: (message: string) => {
            sendEvent('compact_progress', { message });
          },
          signal: request.signal,
          // 'off' is the UI default and means "no explicit level"; only
          // forward an explicit reasoning level so the adapter applies its
          // own default mapping. Mirrors the chat route's convention. The
          // body's pin wins; a conversation that inherits falls back to the
          // saved default.
          reasoningEffort: forwardableReasoningEffort(
            compactionReasoningEffort ?? config?.compactionReasoningEffort
          ),
          // Live compaction speed for the t/s badge.
          onTps: (tps: number) => {
            sendEvent('status', { phase: 'compacting', tps });
          },
          // The user's redaction setting, read from the stored config (the
          // same source the compaction provider is resolved from): with it
          // OFF the summariser sees the raw tool arguments and tool results,
          // with it ON both are redacted.
          redactSecrets: config?.redactSecrets ?? true,
          // What the user asked the summary to keep. `undefined` when the
          // command was typed without a note, which leaves every prompt
          // byte-identical to the pre-focus prompts.
          focus,
          // No borrowed system prompt: `conversationMessages` was stripped of
          // every `system` row above, so `compactHistory` measures 0 for it on
          // both sides of the comparison — the same arithmetic this route has
          // always used. (Passing a number here would charge the stub's budget
          // for a prompt this array does not carry.)
          //
          // The files this session touched most recently (PART A records them in
          // `session_recent_files`), so the model does not re-read them after
          // the compaction. The reader is confined to the agent's working
          // directory. This route has no `WorkingDirectoryScope` of its own (it
          // runs no tools), so it uses the process default — the same directory
          // a tool call with no scope would resolve relative paths against. A
          // path outside it is simply not read, and the stub degrades to its
          // path list.
          recentFiles:
            recentFiles === undefined
              ? undefined
              : { rows: recentFiles, root: getAgentWorkingDirectory() },
        });

        if (parsedSessionId) {
          // Use a reducer so the queue reads current DB state inside the
          // critical section. Compaction replaces the conversation with the
          // summarised result.
          await enqueueSessionWrite(parsedSessionId, (_currentMessages) => result.newMessages, {
            promptEvalCount: result.stats.newTokenCount,
            evalCount: 0,
          });
        }

        debugLog.diagnostic({
          layer: 'route',
          phase: 'compaction_end',
          ...logCtx(),
          provider: compactionLlmRequestContext.provider,
          model: effectiveCompactionModel,
          elapsedMs: Date.now() - compactStartedAt,
          messageCount: result.newMessages.length,
          newTokenCount: result.stats.newTokenCount,
          result: 'completed',
        });

        sendEvent('compact', {
          messages: result.newMessages,
          stats: result.stats,
          // The window the NEXT turn has to fit, so the client can say when a
          // compaction succeeded and still did not make room. This is the
          // MAIN window, not the compaction provider's: a separate compaction
          // model with a huge window does not make the chat model's history
          // any smaller.
          ...(effectiveNumCtx > 0 ? { tokenLimit: effectiveNumCtx } : {}),
        });
      } catch (err) {
        const fallbackMessage = err instanceof Error ? err.message : 'Unknown error';
        const message = await getLlmApiErrorMessage(llmRequestContext, err).catch(
          () => fallbackMessage
        );
        // Distinguish a deliberate client disconnect / dropped stream from a
        // genuine LLM failure. `getLlmApiErrorMessage` surfaces the SDK's
        // "Request was aborted." verbatim, which reads as a pipeline failure
        // even though the client is simply gone (or the browser dropped the
        // socket) — the exact confusion that produced the misleading
        // "Compaction failed: Error in input stream" UI message.
        const clientAborted = request.signal.aborted || /abort/i.test(message);
        debugLog.diagnostic({
          layer: 'route',
          phase: 'compaction_end',
          ...logCtx(),
          provider: llmRequestContext.provider,
          model: effectiveCompactionModel,
          ...(compactStartedAt === null ? {} : { elapsedMs: Date.now() - compactStartedAt }),
          result: clientAborted ? 'client_aborted' : 'failed',
          error: err,
        });
        try {
          sendEvent('error', {
            message: message || fallbackMessage,
            kind: clientAborted ? 'client_abort' : 'llm_error',
          });
        } catch {
          // Controller may already be closed — ignore.
        }
      } finally {
        clearInterval(keepaliveTimer);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
