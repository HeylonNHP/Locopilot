/**
 * aiResponseRenderer.ts
 *
 * Centralised helpers for rendering AI responses.
 *
 * `streamAIResponse`  – owns the full lifecycle of a single AI turn: creates
 *                       the HTTP stream, manages the interrupt handler, shows
 *                       a live character count on the status line while the
 *                       response arrives, then renders the full response via the
 *                       injected `renderAIResponse` once complete.  Returns
 *                       the accumulated content + tool calls + interrupted flag
 *                       to the caller.  The caller only needs to supply the chat
 *                       parameters and a status-update callback.
 */

import {
    sanitize,
    isInterruptRequested,
    registerInterruptHandler,
    unregisterInterruptHandler,
} from './tools/tools';
import { sendLlmChatStream, getLlmTurnStats } from './services/llm';
import { stripSpecialTokens } from './services/textUtils';
import type { ToolCall, ToolDefinition, ChatMessage, LlmTurnStats } from './services/llm';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Chat parameters forwarded to the active LLM adapter. */
export interface StreamAIResponseParams {
    model: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    numCtx: number;
    think?: boolean;
    visionSupported?: boolean;
}

export interface StreamAIResponseOptions {
    /**
     * Callback invoked on each status phase change.  Receives a human-readable
     * string such as `"AI is responding... (342 chars)"`.  Typically wired to
     * `refreshTokenStatus`.
     */
    onStatusUpdate: (status: string) => void;

    /**
     * Optional timeout in milliseconds for the AI response (per chunk or total).
     */
    timeoutMs?: number | undefined;
}

export interface StreamAIResponseResult {
    /** Full accumulated text content from the model. */
    content: string;
    /** The accumulated reasoning trace if the model supports thinking. */
    thinking?: string;
    /** Any tool calls the model requested. */
    toolCalls: ToolCall[];
    /** True if the user interrupted the stream before it completed. */
    interrupted: boolean;
    /** Final provider token/duration stats when provided by the API. */
    finalStats: LlmTurnStats | null;
}

export interface RenderTurnOptions extends StreamAIResponseOptions {
    /** Called when final authoritative stats arrive from Ollama. */
    onFinalStats?: (authoritativeTokensUsed: number, finalStats: LlmTurnStats) => void;
}

// ─── Injectable Renderers ─────────────────────────────────────────────────────

/** Renderer type for AI response output. */
export type AIResponseRenderer = (content: string, opts?: { interrupted?: boolean }) => void;

/** Renderer type for thinking summary output. */
export type ThinkingSummaryRenderer = (durationMs: number, thinkingChars: number) => void;

/** The currently active AI response renderer (defaults to a no-op). */
let renderAIResponse: AIResponseRenderer = () => {};

/** The currently active thinking summary renderer (defaults to a no-op). */
let renderThinkingSummary: ThinkingSummaryRenderer = () => {};

/**
 * Replace the default AI response renderer.
 * Useful for testing, custom UIs, or suppressing output.
 */
export function setAIResponseRenderer(fn: AIResponseRenderer): void {
    renderAIResponse = fn;
}

/**
 * Replace the default thinking summary renderer.
 */
export function setThinkingSummaryRenderer(fn: ThinkingSummaryRenderer): void {
    renderThinkingSummary = fn;
}

/**
 * Convenience wrapper that streams an AI turn and returns a ready-to-insert
 * `assistant` chat message plus session token stats when available.
 *
 * This hides the common pattern of calling `streamAIResponse`, constructing the
 * assistant message object (including any tool calls), and extracting the
 * authoritative token counts so callers can keep the chat-loop concise.
 */
export async function renderTurn(
    baseUrl: string,
    params: StreamAIResponseParams,
    opts: RenderTurnOptions,
): Promise<{
    assistantMessage: ChatMessage | null;
    interrupted: boolean;
    sessionTokenStats: { promptEvalCount: number; evalCount: number } | null;
    finalStats: LlmTurnStats | null;
}> {
    const { onStatusUpdate, onFinalStats, timeoutMs } = opts;

    const result = await streamAIResponse(baseUrl, params, {
        onStatusUpdate,
        timeoutMs,
    });
    const { content, thinking, toolCalls, interrupted, finalStats } = result;

    if (interrupted) {
        return { assistantMessage: null, interrupted: true, sessionTokenStats: null, finalStats };
    }

    let assistantMessage: ChatMessage;
    if (toolCalls.length > 0) {
        assistantMessage = {
            role: 'assistant',
            content,
            ...(thinking ? { thinking } : {}),
            // Ensure a non-empty tuple type: [first, ...rest]
            tool_calls: [toolCalls[0]!, ...toolCalls.slice(1)],
        };
    } else {
        assistantMessage = {
            role: 'assistant',
            content,
            ...(thinking ? { thinking } : {}),
        };
    }

    let sessionTokenStats: { promptEvalCount: number; evalCount: number } | null = null;
    if (finalStats) {
        const authoritativeTokensUsed = finalStats.promptEvalCount + finalStats.evalCount;
        sessionTokenStats = {
            promptEvalCount: finalStats.promptEvalCount,
            evalCount: finalStats.evalCount,
        };
        if (onFinalStats) onFinalStats(authoritativeTokensUsed, finalStats);
    }

    return { assistantMessage, interrupted: false, sessionTokenStats, finalStats };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Streams an AI response and shows a live character count on the status line.
 *
 * Opens the active LLM provider chat stream internally, wires up the interrupt handler, and
 * updates the status line with `"AI is responding... (N chars)"` as each chunk
 * arrives.  No raw text is written to the terminal during this phase.  Once the
 * stream is complete (or interrupted), the full accumulated response is rendered
 * via `renderAIResponse`.
 *
 * Tool-call-only responses (no text content) produce no terminal output.
 *
 * @param baseUrl - Provider base URL (e.g. `http://localhost:11434`).
 * @param params  - Model, messages, tools, and context length.
 * @param opts    - Status-update callback.
 * @returns Accumulated content, tool calls, and whether the stream was cut short.
 */
export async function streamAIResponse(
    baseUrl: string,
    params: StreamAIResponseParams,
    opts: StreamAIResponseOptions,
): Promise<StreamAIResponseResult> {
    const { onStatusUpdate } = opts;

    let content = '';
    let thinking = '';
    const toolCalls: ToolCall[] = [];
    let toolCallRawArgs = '';
    let interrupted = false;
    let finalStats: LlmTurnStats | null = null;

    onStatusUpdate('AI is responding...');

    const abortController = new AbortController();

    const interruptHandlerId = registerInterruptHandler(() => abortController.abort());

    const startTime = Date.now();
    let firstContentTime: number | null = null;
    let thinkingSummaryPrinted = false;

    try {
        const stream = sendLlmChatStream(baseUrl, {
            model: params.model,
            messages: params.messages,
            tools: params.tools,
            numCtx: params.numCtx,
            ...(params.visionSupported !== undefined ? { visionSupported: params.visionSupported } : {}),
            ...(params.think !== undefined ? { think: params.think } : {}),
            signal: abortController.signal,
            timeoutMs: opts.timeoutMs,
        });

        for await (const chunk of stream) {
            if (isInterruptRequested()) {
                interrupted = true;
                abortController.abort();
                break;
            }

            const chunkThinking = chunk.message?.thinking ?? '';
            if (chunkThinking.length > 0) {
                thinking += chunkThinking;
                onStatusUpdate(`AI is thinking... (${thinking.length} chars)`);
            }

            const chunkContent = chunk.message?.content ?? '';
            if (chunkContent.length > 0) {
                if (firstContentTime === null) {
                    firstContentTime = Date.now();
                    if (thinking.length > 0) {
                        renderThinkingSummary(firstContentTime - startTime, thinking.length);
                        thinkingSummaryPrinted = true;
                    }
                }
                content += chunkContent;
                onStatusUpdate(`AI is responding... (${content.length} chars)`);
            }

            if (chunk.message?.tool_calls) {
                // If thinking preceded these tool calls, emit the persistent thought
                // summary now — same timing as for the first content chunk above.
                if (thinking.length > 0 && !thinkingSummaryPrinted) {
                    renderThinkingSummary(Date.now() - startTime, thinking.length);
                    thinkingSummaryPrinted = true;
                }
                // Track the latest complete tool-call snapshot for the final
                // result. Ollama emits tool_calls as a full array in the chunk
                // that carries them, so replacing avoids duplicate execution if
                // the same snapshot is repeated.
                toolCalls.length = 0;
                toolCalls.push(...chunk.message.tool_calls);

                // Reset the raw-args accumulator so the character count reflects
                // only the latest snapshot. Ollama sends complete tool-call
                // snapshots each chunk (see ollama/ollama#11633), not incremental
                // partials, so accumulating across chunks would inflate the count.
                toolCallRawArgs = '';
                for (const tc of chunk.message.tool_calls) {
                    if (tc.function?.arguments) {
                        try {
                            const argsJson = JSON.stringify(tc.function.arguments);
                            toolCallRawArgs += argsJson;
                        } catch {
                            // If it's not stringifiable yet (rare for partials), skip
                        }
                    }
                }
                onStatusUpdate(`AI is requesting tools... (${toolCallRawArgs.length} chars)`);
            }

            if (chunk.done) {
                finalStats = getLlmTurnStats(chunk);
            }
        }
    } catch (error) {
        if (!isInterruptRequested()) throw error;
        interrupted = true;
    } finally {
        unregisterInterruptHandler(interruptHandlerId);
    }

    // Tool-call-only turns may think without emitting assistant content.
    // Print a final thought summary so the thinking duration/chars are visible.
    if (!interrupted && thinking.length > 0 && !thinkingSummaryPrinted) {
        renderThinkingSummary(Date.now() - startTime, thinking.length);
        thinkingSummaryPrinted = true;
    }

    const cleanedContent = stripSpecialTokens(content);
    const cleanedThinking = stripSpecialTokens(thinking);

    if (cleanedContent.trim().length > 0) {
        renderAIResponse(cleanedContent, { interrupted });
    }

    const result: StreamAIResponseResult = { 
        content: cleanedContent, 
        toolCalls, 
        interrupted, 
        finalStats 
    };
    if (cleanedThinking) result.thinking = cleanedThinking;

    return result;
}
