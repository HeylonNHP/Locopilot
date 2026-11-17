import { type NextRequest, NextResponse } from 'next/server';

import { DEFAULT_OLLAMA_BASE_URL } from '@/services/configDefaults';
import { readConfig } from '@/services/configManager';
import { resolveNumCtx } from '@/services/contextWindow/resolveNumCtx';
import { listSessions } from '@/services/history';
import {
  buildConversationDumpMarkdown,
  buildDumpFileName,
  type ConversationDumpInput,
} from '@/services/historyDump';
import { buildLlmRequestContext, type ChatMessage } from '@/services/llm';
import { buildProviderRequestContext, resolveProvider } from '@/services/providerResolver';
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
  // The provider the conversation runs on. Without it the model name is the
  // only hint, and a provider with no default `model` never wins that match,
  // so the dump would label (and judge) `providers[0]` instead.
  const providerId =
    typeof body.providerId === 'string' && body.providerId.trim() !== ''
      ? body.providerId.trim()
      : undefined;

  if (!messages) {
    return NextResponse.json({ error: 'Messages array is required.' }, { status: 400 });
  }

  if (!model) {
    return NextResponse.json({ error: 'Model name is required.' }, { status: 400 });
  }

  // THE DUMP NEVER REFUSES FOR THE CONFIGURATION. It makes no model call: it
  // writes down what the page already holds, and the only thing it asks of a
  // provider is a metadata probe so it can LABEL the window. It is the tool
  // you reach for when something is broken, so a removed provider, a
  // provider that does not serve the model, a missing context size and an
  // unreadable `config.json` are all things it REPORTS in the file.
  const savedConfig = await readConfig();
  const config = savedConfig.ok ? savedConfig.config : null;

  try {
    const effectiveBaseUrl =
      typeof body.baseUrl === 'string' && body.baseUrl.trim().length > 0
        ? body.baseUrl.trim()
        : DEFAULT_OLLAMA_BASE_URL;
    const configRequested =
      config?.numCtx && Number.isFinite(config.numCtx) && config.numCtx > 0
        ? Math.trunc(config.numCtx)
        : undefined;

    // The provider the conversation runs on, resolved exactly as a turn
    // resolves it (by id when the page sent one), so the file says which
    // provider it is about - or why none could be found.
    const provider = config === null ? null : resolveProvider(config, providerId, model);
    let providerLabel: string;
    if (config === null) {
      providerLabel = `(config.json could not be read: ${savedConfig.ok ? '' : savedConfig.message})`;
    } else if (provider !== null) {
      providerLabel = `${provider.name} (${provider.id})`;
    } else if (providerId === undefined) {
      providerLabel = '(no provider is configured)';
    } else {
      providerLabel = `(the provider "${providerId}" is not configured)`;
    }

    // Label the window the server resolves for this model: the saved setting
    // (the provider's own numCtx, else the global one) capped by the model's
    // maximum. The request body is not an input. The probe never throws, and
    // a window that cannot be resolved is labelled `(unknown)`.
    //
    // The probe goes to the provider the conversation runs on. When the page
    // NAMED a provider that is not configured there is nowhere right to ask,
    // so nothing is probed; with no id at all the base URL the page sent is
    // the fallback.
    let runtimeNumCtx: number | null = null;
    if (providerId === undefined || provider !== null) {
      const windowResolution = await resolveNumCtx({
        ctx: provider
          ? buildProviderRequestContext(provider)
          : buildLlmRequestContext({ baseUrl: effectiveBaseUrl }),
        model,
        providerNumCtx: provider?.numCtx,
        configNumCtx: config?.numCtx,
      });
      runtimeNumCtx = windowResolution.effective;
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
      providerLabel,
      runtimeNumCtx,
      savedNumCtx,
      systemPrompt: extractSystemPrompt(messages),
      messages,
      // An unreadable config is shown as what it is, not omitted.
      config: config ?? {
        error: 'config.json could not be read',
        reason: savedConfig.ok ? null : savedConfig.message,
      },
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
