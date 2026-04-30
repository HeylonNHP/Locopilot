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

import { NextRequest } from 'next/server';
import { sendLlmChatStream } from '../../../services/llm';
import type { ChatMessage, StreamChatParams } from '../../../services/llm';
import { TOOLS, handleToolCall, setWebSearchConfig, setYoloMode } from '../../../tools/tools';
import { loadConfig } from '../../../services/configManager';
import { resolveCompactionModel } from '../../../services/modelManager';
import { createSession, updateSessionMessages } from '../../../history';

// Prevent static generation – this route must always run on the server.
export const dynamic = 'force-dynamic';

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

            // Safety limit to prevent infinite tool-calling loops.
            const MAX_TOOL_LOOPS = 20;
            let loopCount = 0;

            // Deep-clone the incoming messages so we never mutate the request body.
            const currentMessages: ChatMessage[] = JSON.parse(JSON.stringify(messages));

            let finalContent = '';
            let finalThinking = '';

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
                        }
                    }
                } catch {
                    // Config load is best-effort; defaults already apply.
                }

                // ── Main tool-calling loop ──────────────────────────────────
                while (loopCount < MAX_TOOL_LOOPS) {
                    loopCount += 1;

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
                            thinking += msg.thinking;
                            sendEvent('thinking', msg.thinking);
                        }

                        // Stream regular content chunks.
                        if (msg?.content) {
                            content += msg.content;
                            sendEvent('chunk', msg.content);
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

                    // -- Build the assistant message --------------------------
                    const assistantMessage: ChatMessage = {
                        role: 'assistant',
                        content,
                    };
                    if (thinking) {
                        assistantMessage.thinking = thinking;
                    }
                    if (toolCalls && toolCalls.length > 0) {
                        assistantMessage.tool_calls = toolCalls;
                    }

                    currentMessages.push(assistantMessage);

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

                            const startTime = Date.now();

                            // Execute the tool via the registry.
                            // Note: onProgress is omitted here; the web UI can rely
                            // on the tool_call / tool_result / status events instead.
                            const result = await handleToolCall(toolName, toolArgs);

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

                    // Create or update session in the database.
                    let currentSessionId = parsedSessionId;
                    if (!currentSessionId) {
                        const sessionName = content.trim().slice(0, 60) || 'Chat';
                        currentSessionId = createSession(sessionName, model as string);
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

                // ── Safety limit reached ────────────────────────────────────
                sendEvent('error', {
                    message: `Tool-calling loop reached the safety limit of ${MAX_TOOL_LOOPS} iterations. The last assistant response may have been incomplete.`,
                });
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
