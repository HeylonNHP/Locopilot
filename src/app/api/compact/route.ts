import { NextRequest, NextResponse } from 'next/server';

import { DEFAULT_NUM_CTX } from '../../../constants';
import { enqueueSessionWrite } from '../../lib/sessionWriteQueue';
import { compactHistory } from '../../../services/compact';
import { loadConfig } from '../../../services/configManager';
import { getLlmApiErrorMessage, type ChatMessage, type PersistedChatMessage, type SubagentLogMessage } from '../../../services/llm';
import { resolveCompactionModel } from '../../../services/modelManager';

export const dynamic = 'force-dynamic';

function isPersistedChatMessage(value: unknown): value is PersistedChatMessage {
    if (typeof value !== 'object' || value === null) return false;
    const msg = value as Record<string, unknown>;
    if (typeof msg.role !== 'string' || typeof msg.content !== 'string') return false;
    if (msg.role === 'subagent_log') {
        return msg.subagentId === undefined || typeof msg.subagentId === 'string';
    }
    return msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool';
}

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

    if (!Array.isArray(messages) || messages.length <= 1 || !messages.every(isPersistedChatMessage)) {
        return NextResponse.json(
            { error: 'Nothing to compact yet. Continue the conversation and try again.' },
            { status: 400 },
        );
    }

    const typedMessages: PersistedChatMessage[] = messages;

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

        // Strip system and subagent_log messages before compacting — system prompt
        // is injected on-the-fly; subagent_log is a client-only UI role unknown to Ollama.
        const subagentLogMessages: SubagentLogMessage[] = typedMessages.filter(
            (m): m is SubagentLogMessage => m.role === 'subagent_log',
        );

        const conversationMessages: ChatMessage[] = typedMessages.filter(
            (m): m is ChatMessage =>
                m.role !== 'system' && m.role !== 'subagent_log',
        );

        const compactPhases: string[] = [];
        const result = await compactHistory(
            effectiveBaseUrl,
            effectiveCompactionModel,
            conversationMessages,
            effectiveNumCtx,
            (message: string) => {
                compactPhases.push(message);
            },
            1.0,
            2,
            undefined,
            request.signal,
        );

        const parsedSessionId = typeof sessionId === 'number' && Number.isFinite(sessionId) && sessionId > 0
            ? sessionId
            : null;
        if (parsedSessionId) {
            // Use a reducer so the queue reads current DB state inside the
            // critical section.  Compaction replaces the conversation with
            // the summarised result plus any subagent_log entries.
            await enqueueSessionWrite(parsedSessionId,
                (_currentMessages) => [...result.newMessages, ...subagentLogMessages],
                {
                    promptEvalCount: result.stats.newTokenCount,
                    evalCount: 0,
                },
            );
        }

        return NextResponse.json({
            messages: result.newMessages,
            stats: result.stats,
            compactionModel: effectiveCompactionModel,
            phases: compactPhases,
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