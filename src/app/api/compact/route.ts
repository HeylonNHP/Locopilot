import { type NextRequest, NextResponse } from 'next/server';

import type { SseEventPayloadMap } from '../../../types/sse';

import { resolveEffectiveNumCtx } from '../../../services/capResolver';
import { compactHistory } from '../../../services/compact';
import { loadConfig } from '../../../services/configManager';
import {
  buildLlmRequestContext,
  type ChatMessage,
  getLlmApiErrorMessage,
  type LlmRequestContext,
  type PersistedChatMessage,
  type SubagentLogMessage,
} from '../../../services/llm';
import { resolveCompactionModel } from '../../../services/modelManager';
import { enqueueSessionWrite } from '../../lib/sessionWriteQueue';

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
  const compactionModel = body.compactionModel;
  const sessionId = body.sessionId;

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
        data: SseEventPayloadMap[N],
      ): void {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Client disconnected — safe to ignore
        }
      }

      // Hoisted so the catch at 170 can use it. The inner try sets the
      // real value from the loaded config; this default is the
      // ollama-default fallback if the error fires before config loads.
      let llmRequestContext: LlmRequestContext = buildLlmRequestContext({
        baseUrl:
          typeof baseUrl === 'string' && baseUrl.trim().length > 0
            ? baseUrl.trim()
            : 'http://localhost:11434',
      });
      try {
        const config = await loadConfig();
        llmRequestContext = buildLlmRequestContext({
          ...(config?.provider ? { provider: config.provider } : {}),
          ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
          baseUrl:
            typeof baseUrl === 'string' && baseUrl.trim().length > 0
              ? baseUrl.trim()
              : config?.baseUrl?.trim() || 'http://localhost:11434',
        });
        // Resolve the effective numCtx against the model's runtime
        // cap. The body numCtx is informational; the resolver
        // prefers the persisted config value (which is the user's
        // authoritative requested cap) and falls back to the body
        // value if config is missing. The clamp is the server's
        // responsibility, not the client's.
        const bodyRequested = typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0
          ? Math.floor(numCtx)
          : null;
        const configRequested =
          config?.numCtx && Number.isFinite(config.numCtx) && config.numCtx > 0
            ? Math.floor(config.numCtx)
            : null;
        const requested = bodyRequested ?? configRequested;
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
        const effectiveCompactionModel = resolveCompactionModel(
          typeof compactionModel === 'string' ? compactionModel : config?.compactionModel,
          model.trim()
        );

        // Strip system and subagent_log messages before compacting — system prompt
        // is injected on-the-fly; subagent_log is a client-only UI role unknown to Ollama.
        const subagentLogMessages: SubagentLogMessage[] = typedMessages.filter(
          (m): m is SubagentLogMessage => m.role === 'subagent_log'
        );

        const conversationMessages: ChatMessage[] = typedMessages.filter(
          (m): m is ChatMessage => m.role !== 'system' && m.role !== 'subagent_log'
        );

        const result = await compactHistory(
          llmRequestContext,
          effectiveCompactionModel,
          conversationMessages,
          effectiveNumCtx,
          (message: string) => {
            sendEvent('compact_progress', { message });
          },
          1,
          2,
          undefined,
          request.signal
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

        sendEvent('compact', {
          messages: result.newMessages,
          stats: result.stats,
        });
      } catch (err) {
        const fallbackMessage = err instanceof Error ? err.message : 'Unknown error';
        const message = await getLlmApiErrorMessage(llmRequestContext, err).catch(() => fallbackMessage);
        sendEvent('error', { message: message || fallbackMessage });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}