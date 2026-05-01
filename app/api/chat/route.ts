/**
 * POST /api/chat – Streaming AI chat route with tool-calling loop.
 *
 * The client sends:
 *   { messages, model, numCtx?, sessionId?, baseUrl?, think? }
 *
 * The server runs the full AI agent loop (LLM → tools → LLM → …) and
 * streams back Server-Sent Events (SSE) for every incremental update.
 *
 * SSE event types:
 *   event: thinking\ndata: <string>\n\n
 *   event: chunk\ndata: <string>\n\n
 *   event: tool_call\ndata: {"name":"…","arguments":{…}}\n\n
 *   event: tool_result\ndata: {"name":"…","result":"…","duration":123}\n\n
 *   event: status\ndata: {"phase":"thinking"|"responding"|"tools","tokensUsed":N,"tokenLimit":N}\n\n
 *   event: done\ndata: {"content":"…","thinking":"…","sessionId":N,"tokenStats":{…}}\n\n
 *   event: error\ndata: {"message":"…"}\n\n
 */

import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { sendLlmChatStream } from '../../../services/llm';
import type { ChatMessage, StreamChatParams } from '../../../services/llm';
import { TOOLS, handleToolCall, sanitize, setSubAgentConfig, setWebSearchConfig, setYoloMode, type ToolOutputSink } from '../../../tools/tools';
import { waitForApproval, resolveApproval } from '../../lib/approvalRegistry';
import { loadConfig } from '../../../services/configManager';
import { resolveCompactionModel } from '../../../services/modelManager';
import { createSession, renameSession, updateSessionMessages } from '../../../history';
import { compactHistory } from '../../../services/compact';
import { countMessagesTokens } from '../../../services/tokenizer';
import { AUTO_COMPACT_THRESHOLD_PCT } from '../../../constants';
import { sanitizeChatMessage, stripSpecialTokens } from '../../../services/textUtils';

// Prevent static generation – this route must always run on the server.
export const dynamic = 'force-dynamic';

const MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS = 3;
const CHANNEL_LABEL_ONLY_PATTERN = /^\s*(?:thought|analysis|final|commentary)\s*$/i;

function sanitizeAssistantTextFragment(text: string): string {
    const cleaned = stripSpecialTokens(text ?? '');
    return CHANNEL_LABEL_ONLY_PATTERN.test(cleaned.trim()) ? '' : cleaned;
}

function hasMeaningfulAssistantContent(message: ChatMessage): boolean {
    const cleanedContent = sanitizeAssistantTextFragment(message.content ?? '').trim();
    if (cleanedContent.length === 0) {
        return false;
    }

    return !CHANNEL_LABEL_ONLY_PATTERN.test(cleanedContent);
}

export async function POST(req: NextRequest): Promise<Response> {
    // ── Parse & validate the request body ──────────────────────────────
    let body: Record<string, unknown>;
    try {
        body = await req.json() as Record<string, unknown>;
    } catch {
        return new Response(
            `event: error\ndata: ${JSON.stringify({ message: 'Invalid JSON body' })}\n\n`,
            {
                status: 400,
                headers: { 'Content-Type': 'text/event-stream' },
            },
        );
    }

    const messages: unknown = body.messages;
    const model: unknown = body.model;
    const numCtx: unknown = body.numCtx;
    const sessionId: unknown = body.sessionId;
    const baseUrl: unknown = body.baseUrl;
    const think: unknown = body.think;

    // -- Validation ------------------------------------------------
    if (typeof model !== 'string' || !model.trim()) {
        return new Response(
            `event: error\ndata: ${JSON.stringify({ message: 'Model name is required' })}\n\n`,
            {
                status: 400,
                headers: { 'Content-Type': 'text/event-stream' },
            },
        );
    }

    if (!Array.isArray(messages) || messages.length === 0) {
        return new Response(
            `event: error\ndata: ${JSON.stringify({ message: 'Messages array is required and must not be empty' })}\n\n`,
            {
                status: 400,
                headers: { 'Content-Type': 'text/event-stream' },
            },
        );
    }

    const effectiveBaseUrl = typeof baseUrl === 'string' && baseUrl.trim()
        ? baseUrl.trim()
        : 'http://localhost:11434';

    const effectiveNumCtx = typeof numCtx === 'number' && Number.isFinite(numCtx) && numCtx > 0
        ? Math.floor(numCtx)
        : 4096;

    const parsedSessionId = typeof sessionId === 'number'
        ? sessionId
        : undefined;

    const thinkEnabled = typeof think === 'boolean' ? think : undefined;

    // ── SSE streaming setup ───────────────────────────────────────────
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller): Promise<void> {
            function sendEvent(event: string, data: unknown): void {
                controller.enqueue(
                    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                );
            }

            // Deep-clone the incoming messages so we never mutate the request body.
            const currentMessages: ChatMessage[] = JSON.parse(JSON.stringify(messages));

            let finalContent = '';
            let finalThinking = '';
            // Compaction model resolved from config (set below); starts as the chat model.
            let effectiveCompactionModel: string = model as string;
            // Last authoritative token count from Ollama; used by the auto-compact
            // check so it matches the CLI's anchored estimate.
            let lastAuthoritativeTokens = 0;
            // Whether YOLO mode is active (set from config below). When true,
            // run_command skips the approval gate and executes unconditionally.
            let effectiveYolo = false;
            let emptyResponseRecoveryAttempts = 0;

            // ── Eagerly create the session so it appears in the sidebar immediately ──
            // If the client already has a session ID (resuming), use it as-is.
            // Otherwise create a placeholder session now and rename it once we have
            // the actual AI response content.
            let activeSessionId: number | undefined = parsedSessionId;
            if (!activeSessionId) {
                activeSessionId = createSession('New chat', model as string);
                sendEvent('session_created', { sessionId: activeSessionId });
            }

            try {
                // Load runtime tool configuration from disk so that web search
                // and YOLO settings reflect the latest user preferences.
                try {
                    const config = await loadConfig();
                    if (config) {
                        if (config.webSearch) {
                            setWebSearchConfig({
                                maxQueries: config.webSearch.maxQueries,
                                resultsPerQuery: config.webSearch.resultsPerQuery,
                                perPageCharLimit: config.webSearch.perPageCharLimit,
                                baseUrl: config.baseUrl || effectiveBaseUrl,
                                compactionModel: resolveCompactionModel(config.compactionModel, model as string),
                            });
                        }
                        if (typeof config.yolo === 'boolean') {
                            setYoloMode(config.yolo);
                            effectiveYolo = config.yolo;
                        }

                        effectiveCompactionModel = resolveCompactionModel(config.compactionModel, model as string);

                        // Configure the sub-agent tool with the current session parameters
                        // so that run_subagents can spawn isolated workers with the right model/context.
                        setSubAgentConfig({
                            baseUrl: config.baseUrl || effectiveBaseUrl,
                            model: model as string,
                            numCtx: effectiveNumCtx,
                            compactionModel: resolveCompactionModel(config.compactionModel, model as string),
                            tools: TOOLS.filter((tool) => tool.function.name !== 'run_subagents'),
                        });
                    } else {
                        // No config file — set sub-agent config with request defaults.
                        setSubAgentConfig({
                            baseUrl: effectiveBaseUrl,
                            model: model as string,
                            numCtx: effectiveNumCtx,
                            compactionModel: model as string,
                            tools: TOOLS.filter((tool) => tool.function.name !== 'run_subagents'),
                        });
                    }
                } catch {
                    // Config load is best-effort; defaults already apply.
                    // Ensure sub-agent config is set even when config load fails.
                    setSubAgentConfig({
                        baseUrl: effectiveBaseUrl,
                        model: model as string,
                        numCtx: effectiveNumCtx,
                        compactionModel: model as string,
                        tools: TOOLS.filter((tool) => tool.function.name !== 'run_subagents'),
                    });
                }

                // ── Main tool-calling loop ──────────────────────────────────
                while (true) {

                    // Auto-compact when approaching the context limit, mirroring the
                    // CLI's autoCompactIfNeeded() in services/chatSession.ts.
                    if (effectiveNumCtx > 0) {
                        const tokensUsed = lastAuthoritativeTokens > 0
                            ? lastAuthoritativeTokens
                            : countMessagesTokens(currentMessages, model as string);
                        const usagePct = (tokensUsed / effectiveNumCtx) * 100;

                        if (usagePct >= AUTO_COMPACT_THRESHOLD_PCT) {
                            sendEvent('status', {
                                phase: 'compacting',
                                tokensUsed,
                                tokenLimit: effectiveNumCtx,
                            });
                            try {
                                const compactResult = await compactHistory(
                                    effectiveBaseUrl,
                                    effectiveCompactionModel,
                                    currentMessages,
                                    effectiveNumCtx,
                                );
                                // Send the compacted message list to the client BEFORE
                                // appending the LLM-only continuation nudge, so the
                                // client's state mirrors the clean compacted history.
                                sendEvent('compact', {
                                    messages: compactResult.newMessages,
                                    stats: compactResult.stats,
                                });
                                // Replace server-side history with the compacted result.
                                currentMessages.splice(0, currentMessages.length, ...compactResult.newMessages);
                                // LLM-only nudge – not sent to the client.
                                currentMessages.push({
                                    role: 'user',
                                    content:
                                        'The conversation history was automatically compacted due to context length. ' +
                                        'Please continue working on the original task without asking for confirmation.',
                                });
                                lastAuthoritativeTokens = 0;
                                if (compactResult.stats.newTokenCount > effectiveNumCtx) {
                                    sendEvent('status', {
                                        phase: 'compact_overflow',
                                        tokensUsed: compactResult.stats.newTokenCount,
                                        tokenLimit: effectiveNumCtx,
                                    });
                                }
                            } catch (compactErr) {
                                // Non-fatal — log and continue with existing messages.
                                sendEvent('status', {
                                    phase: 'compact_failed',
                                    tokensUsed,
                                    tokenLimit: effectiveNumCtx,
                                });
                            }
                        }
                    }

                    // Signal that we are about to start an LLM call.
                    sendEvent('status', {
                        phase: 'thinking',
                        tokensUsed: undefined,
                        tokenLimit: effectiveNumCtx,
                    });

                    // -- Call the LLM via the active adapter ------------------
                    const params: StreamChatParams = {
                        model: model as string,
                        messages: currentMessages,
                        tools: TOOLS,
                        numCtx: effectiveNumCtx,
                        signal: req.signal,
                    };
                    if (thinkEnabled !== undefined) {
                        params.think = thinkEnabled;
                    }

                    let content = '';
                    let thinking = '';
                    let toolCalls: ChatMessage['tool_calls'] | undefined;
                    let promptEvalCount = 0;
                    let evalCount = 0;

                    const llmStream = sendLlmChatStream(effectiveBaseUrl, params);

                    for await (const chunk of llmStream) {
                        const msg = chunk.message;

                        // Stream thinking token chunks (e.g. for deep-thinking models).
                        if (msg?.thinking) {
                            const thinkingChunk = sanitizeAssistantTextFragment(msg.thinking);
                            if (thinkingChunk) {
                                thinking += thinkingChunk;
                                sendEvent('thinking', thinkingChunk);
                            }
                        }

                        // Stream regular content chunks.
                        if (msg?.content) {
                            const contentChunk = sanitizeAssistantTextFragment(msg.content);
                            if (contentChunk) {
                                content += contentChunk;
                                sendEvent('chunk', contentChunk);
                            }
                        }

                        // Capture tool calls from the final (or any) chunk.
                        if (msg?.tool_calls && msg.tool_calls.length > 0) {
                            toolCalls = msg.tool_calls;
                        }

                        // Capture authoritative token counts from the final chunk.
                        if (chunk.done) {
                            promptEvalCount = chunk.prompt_eval_count ?? 0;
                            evalCount = chunk.eval_count ?? 0;
                        }
                    }

                    // Anchor the token estimate to Ollama's authoritative count so
                    // the next loop iteration's auto-compact check is accurate.
                    lastAuthoritativeTokens = promptEvalCount + evalCount;

                    // -- Build the assistant message --------------------------
                    const assistantMessage = sanitizeChatMessage({
                        role: 'assistant',
                        content,
                    });
                    if (thinking) {
                        assistantMessage.thinking = thinking;
                    }
                    if (toolCalls && toolCalls.length > 0) {
                        assistantMessage.tool_calls = toolCalls;
                    }

                    currentMessages.push(assistantMessage);

                    if ((!toolCalls || toolCalls.length === 0) && !hasMeaningfulAssistantContent(assistantMessage)) {
                        if (emptyResponseRecoveryAttempts < MAX_EMPTY_RESPONSE_RECOVERY_ATTEMPTS) {
                            emptyResponseRecoveryAttempts += 1;
                            currentMessages.push({
                                role: 'user',
                                content:
                                    'Your last response was empty. Provide a direct answer now. ' +
                                    'If commands are needed, call run_command. If commands already ran, summarize their output and errors.',
                            });
                            continue;
                        }
                    } else {
                        emptyResponseRecoveryAttempts = 0;
                    }

                    // -- Handle tool calls if present -------------------------
                    if (toolCalls && toolCalls.length > 0) {
                        sendEvent('status', {
                            phase: 'tools',
                            tokensUsed: promptEvalCount + evalCount,
                            tokenLimit: effectiveNumCtx,
                        });

                        const tokensUsedSoFar = promptEvalCount + evalCount;

                        for (const tc of toolCalls) {
                            const toolName = tc.function.name;
                            let toolArgs = tc.function.arguments;
                            if (typeof toolArgs === 'string') {
                                try { toolArgs = JSON.parse(toolArgs); } catch {}
                            }

                            sendEvent('tool_call', {
                                name: toolName,
                                arguments: toolArgs,
                            });

                            // ── Approval gate for run_command (skipped in YOLO mode) ────
                            if (toolName === 'run_command' && !effectiveYolo) {
                                const requestId = randomUUID();

                                // Race the user decision against an abort signal so the
                                // server doesn't hang if the client disconnects.
                                const abortPromise = new Promise<boolean>((resolve) => {
                                    if (req.signal.aborted) { resolve(false); return; }
                                    req.signal.addEventListener('abort', () => resolve(false), { once: true });
                                });

                                sendEvent('approval_request', {
                                    requestId,
                                    toolName,
                                    args: toolArgs,
                                });

                                const approved = await Promise.race([
                                    waitForApproval(requestId),
                                    abortPromise,
                                ]);

                                // Clean up registry entry when the abort path won the race.
                                resolveApproval(requestId, false);

                                if (!approved) {
                                    const rejectedResult = '[Command rejected by user]';
                                    sendEvent('tool_result', {
                                        name: toolName,
                                        result: rejectedResult,
                                        duration: 0,
                                    });
                                    currentMessages.push({ role: 'tool', content: rejectedResult });
                                    continue;
                                }
                            }
                            // ────────────────────────────────────────────────────────────

                            const startTime = Date.now();

                            const shouldSurfaceToolProgress = toolName === 'web_search' || toolName === 'fetch_url';
                            const webToolOutput: ToolOutputSink = {
                                writeLine(message: string): void {
                                    sendEvent('tool_progress', {
                                        name: toolName,
                                        message: sanitize(message),
                                    });
                                },
                                writeInline(_message: string): void {
                                    // Ignore inline progress updates in the web UI to avoid
                                    // spamming one message with token-by-token churn.
                                },
                                clearInline(): void {
                                    // No-op for the web UI.
                                },
                            };

                            // Subagent output sink: strips ANSI, parses the [sub-agent: id]
                            // prefix that makeLabeledSink prepends, and emits per-agent SSE
                            // events so the client can render each agent in its own bubble.
                            const subagentOutputSink: ToolOutputSink = {
                                writeLine(message: string): void {
                                    const clean = sanitize(message);
                                    const match = clean.match(/^\[sub-agent:\s*([^\]]+)\]\s([\s\S]*)$/);
                                    const agentId = match ? match[1]!.trim() : '__subagent__';
                                    const text = match ? (match[2] ?? '').trimEnd() : clean.trimEnd();
                                    if (text.trim()) {
                                        sendEvent('subagent_output', { agentId, message: text });
                                    }
                                },
                                writeInline(_message: string): void {},
                                clearInline(): void {},
                            };

                            // Execute the tool via the registry.
                            const result = shouldSurfaceToolProgress
                                ? await handleToolCall(toolName, toolArgs, undefined, webToolOutput)
                                : toolName === 'run_subagents'
                                    ? await handleToolCall(toolName, toolArgs, undefined, subagentOutputSink)
                                    : await handleToolCall(toolName, toolArgs);

                            const duration = Date.now() - startTime;

                            sendEvent('tool_result', {
                                name: toolName,
                                result: result.content,
                                duration,
                            });

                            const toolMessage: ChatMessage = {
                                role: 'tool',
                                content: result.content,
                            };
                            if (result.images && result.images.length > 0) {
                                toolMessage.images = result.images;
                            }
                            currentMessages.push(toolMessage);
                        }

                        // Signal we are switching back to the LLM with tool results.
                        sendEvent('status', {
                            phase: 'responding',
                            tokensUsed: tokensUsedSoFar,
                            tokenLimit: effectiveNumCtx,
                        });

                        // Continue the loop so the LLM can process the tool results.
                        continue;
                    }

                    // -- No tool calls – this is the final response -----------
                    finalContent = content;
                    finalThinking = thinking;

                    // Rename the session from the placeholder to a content-derived title.
                    const currentSessionId = activeSessionId!;
                    if (!parsedSessionId) {
                        renameSession(currentSessionId, content.trim().slice(0, 60) || 'Chat');
                    }

                    updateSessionMessages(currentSessionId, currentMessages, {
                        promptEvalCount,
                        evalCount,
                    });

                    const totalTokens = promptEvalCount + evalCount;

                    sendEvent('done', {
                        content: finalContent,
                        thinking: finalThinking,
                        sessionId: currentSessionId,
                        tokenStats: {
                            promptEvalCount,
                            evalCount,
                            totalTokens,
                            tokenLimit: effectiveNumCtx,
                        },
                    });

                    controller.close();
                    return;
                }


            } catch (err: unknown) {
                // If the request was aborted (client disconnected), close silently.
                if (err instanceof DOMException && err.name === 'AbortError') {
                    try { controller.close(); } catch { /* ignore */ }
                    return;
                }

                const message = err instanceof Error ? err.message : 'An unexpected error occurred';

                try {
                    sendEvent('error', { message });
                } catch {
                    // Controller may already be closed – ignore.
                }
            } finally {
                try {
                    controller.close();
                } catch {
                    // Already closed – ignore.
                }
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
