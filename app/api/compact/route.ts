import { NextRequest, NextResponse } from 'next/server';

import { DEFAULT_NUM_CTX } from '../../../constants';
import { enqueueSessionWrite } from '../../lib/sessionWriteQueue';
import { compactHistory } from '../../../services/compact';
import { loadConfig } from '../../../services/configManager';
import { getLlmApiErrorMessage, type ChatMessage } from '../../../services/llm';
import { resolveCompactionModel } from '../../../services/modelManager';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
    let body: Record<string, unknown>;
    try {
        body = await request.json() as Record<string, unknown>;
    } catch {
        return NextResponse.json(
            { error: 'Invalid JSON body.' },
            { status: 400 },
        );
    }

    const messages = body.messages;
    const model = body.model;
    const numCtx = body.numCtx;
    const baseUrl = body.baseUrl;
    const compactionModel = body.compactionModel;
    const sessionId = body.sessionId;

    if (typeof model !== 'string' || !model.trim()) {
        return NextResponse.json(
            { error: 'Model name is required.' },
            { status: 400 },
        );
    }

    if (!Array.isArray(messages) || messages.length <= 1) {
        return NextResponse.json(
            { error: 'Nothing to compact yet. Continue the conversation and try again.' },
            { status: 400 },
        );
    }

    try {
        const config = await loadConfig();
        const effectiveBaseUrl = typeof baseUrl === 'string' && baseUrl.trim().length > 0
            ? baseUrl.trim()
            : config?.baseUrl?.trim() || 'http://localhost:11434';
        const effectiveNumCtx = typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0
            ? Math.floor(numCtx)
            : config?.numCtx && Number.isFinite(config.numCtx) && config.numCtx > 0
                ? Math.floor(config.numCtx)
                : DEFAULT_NUM_CTX;
        const effectiveCompactionModel = resolveCompactionModel(
            typeof compactionModel === 'string' ? compactionModel : config?.compactionModel,
            model.trim(),
        );

        // Strip system messages before compacting — system prompt is injected on-the-fly
        const conversationMessages = (messages as ChatMessage[]).filter((m) => m.role !== 'system');

        const result = await compactHistory(
            effectiveBaseUrl,
            effectiveCompactionModel,
            conversationMessages,
            effectiveNumCtx,
        );

        const parsedSessionId = typeof sessionId === 'number' && Number.isFinite(sessionId) && sessionId > 0
            ? sessionId
            : null;
        if (parsedSessionId) {
            await enqueueSessionWrite(parsedSessionId, result.newMessages, {
                promptEvalCount: result.stats.newTokenCount,
                evalCount: 0,
            });
        }

        return NextResponse.json({
            messages: result.newMessages,
            stats: result.stats,
            compactionModel: effectiveCompactionModel,
        });
    } catch (error) {
        const fallbackMessage = error instanceof Error ? error.message : 'Unknown error';
        const message = await getLlmApiErrorMessage(error).catch(() => fallbackMessage);
        const status = error instanceof Error && error.message.includes('too short to compact')
            ? 400
            : 500;

        return NextResponse.json(
            { error: message || fallbackMessage },
            { status },
        );
    }
}