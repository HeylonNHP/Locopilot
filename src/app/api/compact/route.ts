import { type NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import type { SseEventPayloadMap } from '@/types/sse';

import { debugLog } from '@/app/lib/debugLogger';
import { enqueueSessionWrite } from '@/app/lib/sessionWriteQueue';
import { SSE_KEEPALIVE_MS } from '@/constants';
import { resolveEffectiveNumCtx } from '@/services/capResolver';
import { compactHistory } from '@/services/compact';
import { DEFAULT_OLLAMA_BASE_URL } from '@/services/configDefaults';
import { loadConfig } from '@/services/configManager';
import {
  buildLlmRequestContext,
  type ChatMessage,
  getLlmApiErrorMessage,
  type LlmRequestContext,
  type PersistedChatMessage,
  type SubagentLogMessage,
} from '@/services/llm';
import { resolveCompactionModel } from '@/services/modelManager';
import { getProviderNumCtx, resolveProviderRequestContext } from '@/services/providerResolver';
import { isReasoningEffort, type ReasoningEffort } from '@/types/chatConfig';

export const dynamic = 'force-dynamic';

function isPersistedChatMessage(value: unknown): value is PersistedChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  if (typeof msg.role !== 'string' || typeof msg.content !== 'string') return false;
  if (msg.role === 'subagent_log') {
    return msg.subagentId === undefined || typeof msg.subagentId === 'string';
  }
  return (
    msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const messages = body.messages;
  const model = body.model;
  const numCtx = body.numCtx;
  const baseUrl = body.baseUrl;
  const providerId = body.providerId;
  const compactionModel = body.compactionModel;
  const compactionProviderId = body.compactionProviderId;
  const sessionId = body.sessionId;

  const compactionReasoningEffortRaw: unknown = body.compactionReasoningEffort;
  const compactionReasoningEffort: ReasoningEffort | undefined = isReasoningEffort(
    compactionReasoningEffortRaw
  )
    ? compactionReasoningEffortRaw
    : undefined;

  if (typeof model !== 'string' || !model.trim()) {
    return NextResponse.json({ error: 'Model name is required.' }, { status: 400 });
  }

  if (!Array.isArray(messages) || messages.length <= 1 || !messages.every(isPersistedChatMessage)) {
    return NextResponse.json(
      { error: 'Nothing to compact yet. Continue the conversation and try again.' },
      { status: 400 }
    );
  }

  const typedMessages: PersistedChatMessage[] = messages;

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
        const config = await loadConfig();
        const resolved = resolveProviderRequestContext(
          config,
          typeof providerId === 'string' ? providerId : undefined,
          model as string
        );
        // No provider resolved (e.g. a stale providerId with no model
        // match). Fall back to the body baseUrl or the default Ollama
        // URL. The fallback is UNauthenticated — never pair a provider's
        // apiKey with the body baseUrl. A stale providerId on a
        // multi-provider config could otherwise leak the user's API key
        // to a caller-supplied host.
        llmRequestContext = resolved
          ? resolved.ctx
          : buildLlmRequestContext({
              baseUrl:
                typeof baseUrl === 'string' && baseUrl.trim().length > 0
                  ? baseUrl.trim()
                  : DEFAULT_OLLAMA_BASE_URL,
            });
        // Resolve the effective numCtx against the model's runtime cap.
        // The body numCtx is an explicit per-request override; otherwise the
        // resolved provider's numCtx wins, falling back to the global config
        // value and finally DEFAULT_NUM_CTX. The clamp is the server's
        // responsibility, not the client's.
        const bodyRequested =
          typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0
            ? Math.floor(numCtx)
            : null;
        const providerRequested = resolved
          ? getProviderNumCtx(resolved.provider, config?.numCtx)
          : config?.numCtx && Number.isFinite(config.numCtx) && config.numCtx > 0
            ? Math.floor(config.numCtx)
            : null;
        const requested = bodyRequested ?? providerRequested;
        let effectiveNumCtx = requested ?? 0;
        if (requested !== null) {
          try {
            const resolved = await resolveEffectiveNumCtx(
              llmRequestContext,
              model as string,
              requested
            );
            effectiveNumCtx = resolved.effective;
          } catch {
            // Resolver is best-effort; fall through with the
            // requested value.
          }
        }
        const effectiveCompactionModelResolved = resolveCompactionModel(
          typeof compactionModel === 'string' ? compactionModel : config?.compactionModel,
          model.trim()
        );
        effectiveCompactionModel = effectiveCompactionModelResolved;

        // Resolve a separate provider for the compaction LLM call ONLY when
        // the client explicitly supplied a compactionProviderId. This lets
        // the user pick a compaction model from a different provider than
        // the main chat model. When no compactionProviderId is supplied
        // (e.g. "Same as main model", or a legacy client) we MUST use the
        // main resolved context directly. Falling back to model-name
        // resolution here is unsafe: if the active model is not stored as
        // any provider's default `model`, resolveProvider falls back to
        // providers[0], sending the compaction request to the wrong
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

        // numCtx for the compaction LLM call. When a compaction provider
        // resolved, prefer ITS numCtx so a per-provider context limit is
        // honored; otherwise use the main effectiveNumCtx.
        const compactionNumCtx = compactionResolved
          ? getProviderNumCtx(compactionResolved.provider, config?.numCtx)
          : effectiveNumCtx;

        // Strip system and subagent_log messages before compacting — system prompt
        // is injected on-the-fly; subagent_log is a client-only UI role unknown to Ollama.
        const subagentLogMessages: SubagentLogMessage[] = typedMessages.filter(
          (m): m is SubagentLogMessage => m.role === 'subagent_log'
        );

        const conversationMessages: ChatMessage[] = typedMessages.filter(
          (m): m is ChatMessage => m.role !== 'system' && m.role !== 'subagent_log'
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

        const result = await compactHistory(
          compactionLlmRequestContext,
          effectiveCompactionModel,
          conversationMessages,
          compactionNumCtx,
          (message: string) => {
            sendEvent('compact_progress', { message });
          },
          1,
          2,
          undefined,
          request.signal,
          // 'off' is the UI default and means "no explicit level"; only
          // forward an explicit reasoning level so the adapter applies its
          // own default mapping. Mirrors the chat route's convention.
          compactionReasoningEffort !== undefined && compactionReasoningEffort !== 'off'
            ? compactionReasoningEffort
            : undefined,
          // Live compaction speed for the t/s badge.
          (tps: number) => {
            sendEvent('status', { phase: 'compacting', tps });
          }
        );

        const parsedSessionId =
          typeof sessionId === 'number' && Number.isFinite(sessionId) && sessionId > 0
            ? sessionId
            : null;
        if (parsedSessionId) {
          // Use a reducer so the queue reads current DB state inside the
          // critical section.  Compaction replaces the conversation with
          // the summarised result plus any subagent_log entries.
          await enqueueSessionWrite(
            parsedSessionId,
            (_currentMessages) => [...result.newMessages, ...subagentLogMessages],
            {
              promptEvalCount: result.stats.newTokenCount,
              evalCount: 0,
            }
          );
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
