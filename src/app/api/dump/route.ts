import { type NextRequest, NextResponse } from 'next/server';

import { resolveEffectiveNumCtx } from '@/services/capResolver';
import { loadConfig } from '@/services/configManager';
import { listSessions } from '@/services/history';
import {
  buildConversationDumpMarkdown,
  buildDumpFileName,
  type ConversationDumpInput,
} from '@/services/historyDump';
import { buildLlmRequestContext, type ChatMessage } from '@/services/llm';
import { getLastWebCompactionDebug } from '@/tools/impl/contentCompactor';

export const dynamic = 'force-dynamic';

function parsePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function extractSystemPrompt(messages: ChatMessage[]): string {
  const firstMessage = messages[0];
  if (!firstMessage || firstMessage.role !== 'system') {
    return '';
  }

  return typeof firstMessage.content === 'string' ? firstMessage.content : '';
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : null;
  const model = typeof body.model === 'string' ? body.model.trim() : '';

  if (!messages) {
    return NextResponse.json({ error: 'Messages array is required.' }, { status: 400 });
  }

  if (!model) {
    return NextResponse.json({ error: 'Model name is required.' }, { status: 400 });
  }

  try {
    const config = await loadConfig();
    const effectiveBaseUrl =
      typeof body.baseUrl === 'string' && body.baseUrl.trim().length > 0
        ? body.baseUrl.trim()
        : config?.baseUrl?.trim() || 'http://localhost:11434';
    // Resolve the effective numCtx against the model's runtime
    // cap for the dump's runtimeNumCtx field. The dump is
    // informational (no LLM call) so the cap is just a
    // best-effort label. The savedNumCtx field is the user's
    // persisted requested value.
    const bodyRequested = parsePositiveInteger(body.numCtx);
    const configRequested =
      config?.numCtx && Number.isFinite(config.numCtx) && config.numCtx > 0
        ? Math.trunc(config.numCtx)
        : undefined;
    const requested = bodyRequested ?? configRequested ?? 0;
    let effectiveNumCtx = requested;
    if (requested > 0) {
      try {
        const resolved = await resolveEffectiveNumCtx(
          buildLlmRequestContext({
            ...(config?.provider ? { provider: config.provider } : {}),
            ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
            baseUrl: effectiveBaseUrl,
          }),
          model,
          requested
        );
        effectiveNumCtx = resolved.effective;
      } catch {
        // Resolver is best-effort.
      }
    }
    const savedNumCtx = configRequested;
    const parsedSessionId = parsePositiveInteger(body.sessionId);
    const sessionName = parsedSessionId
      ? listSessions().find((session) => session.id === parsedSessionId)?.name
      : undefined;

    const dumpInput: ConversationDumpInput = {
      sessionId: parsedSessionId,
      sessionName,
      currentModel: model,
      baseUrl: effectiveBaseUrl,
      runtimeNumCtx: effectiveNumCtx,
      savedNumCtx,
      systemPrompt: extractSystemPrompt(messages),
      messages,
      config,
      webCompactionDebug: getLastWebCompactionDebug(),
    };

    const markdown = buildConversationDumpMarkdown(dumpInput);
    const fileName = buildDumpFileName(dumpInput);

    return new NextResponse(markdown, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to generate conversation dump: ${message}` },
      { status: 500 }
    );
  }
}
