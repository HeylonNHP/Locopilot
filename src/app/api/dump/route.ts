import { type NextRequest, NextResponse } from 'next/server';

import { DEFAULT_NUM_CTX } from '../../../constants';
import { listSessions } from '../../../history';
import { loadConfig } from '../../../services/configManager';
import {
  buildConversationDumpMarkdown,
  buildDumpFileName,
  type ConversationDumpInput,
} from '../../../services/historyDump';
import { type ChatMessage } from '../../../services/llm';
import { getLastWebCompactionDebug } from '../../../tools/impl/contentCompactor';

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
    const effectiveNumCtx =
      parsePositiveInteger(body.numCtx) ??
      (config?.numCtx && Number.isFinite(config.numCtx) && config.numCtx > 0
        ? Math.trunc(config.numCtx)
        : DEFAULT_NUM_CTX);
    const savedNumCtx =
      config?.numCtx && Number.isFinite(config.numCtx) && config.numCtx > 0
        ? Math.trunc(config.numCtx)
        : undefined;
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
