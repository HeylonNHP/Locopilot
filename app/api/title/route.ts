import { NextRequest, NextResponse } from 'next/server';

import { DEFAULT_NUM_CTX } from '../../../constants';
import { listSessions, renameSession } from '../../../history';
import { generateSessionTitle } from '../../../services/compact';
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
            { error: 'Not enough conversation history to generate a title yet.' },
            { status: 400 },
        );
    }

    const parsedSessionId = typeof sessionId === 'number' && Number.isFinite(sessionId) && sessionId > 0
        ? sessionId
        : null;
    if (!parsedSessionId) {
        return NextResponse.json(
            { error: 'This conversation does not have a saved session yet.' },
            { status: 400 },
        );
    }

    const session = listSessions().find((candidate) => candidate.id === parsedSessionId);
    if (!session) {
        return NextResponse.json(
            { error: `Session with id ${parsedSessionId} not found.` },
            { status: 404 },
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

        // Strip system messages — system prompt is not needed for title generation
        const conversationMessages = (messages as ChatMessage[]).filter((m) => m.role !== 'system');

        const title = await generateSessionTitle(
            effectiveBaseUrl,
            effectiveCompactionModel,
            conversationMessages,
            effectiveNumCtx,
        );

        renameSession(parsedSessionId, title);

        return NextResponse.json({
            sessionId: parsedSessionId,
            title,
        });
    } catch (error) {
        const fallbackMessage = error instanceof Error ? error.message : 'Unknown error';
        const message = await getLlmApiErrorMessage(error).catch(() => fallbackMessage);

        return NextResponse.json(
            { error: message || fallbackMessage },
            { status: 500 },
        );
    }
}