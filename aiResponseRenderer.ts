/**
 * aiResponseRenderer.ts
 *
 * Centralised helpers for rendering AI responses in the terminal.
 *
 * `printAIResponse`   – prints a pre-built AI message string with the correct
 *                       label, markdown rendering, and status line cleanup.
 *                       Use this for fallback/error messages where you already
 *                       have the full text.
 *
 * `streamAIResponse`  – owns the full lifecycle of a single AI turn: creates
 *                       the HTTP stream, manages the interrupt handler, shows
 *                       a live character count on the status line while the
 *                       response arrives, then renders the full response as
 *                       formatted markdown once complete.  Returns the
 *                       accumulated content + tool calls + interrupted flag to
 *                       the caller.  The caller only needs to supply the chat
 *                       parameters and a status-update callback.
 */

import chalk from 'chalk';
import { renderMarkdown } from './services/markdownRenderer.js';
import { clearLiveStatus } from './statusLine.js';
import {
    sanitize,
    isInterruptRequested,
    registerInterruptHandler,
    unregisterInterruptHandler,
} from './tools/tools.js';
import { sendOllamaChatStream, getOllamaTurnStats } from './ollamaApi.js';
import type { OllamaToolCall, OllamaToolDefinition, ChatMessage } from './ollamaApi.js';
import type { OllamaTurnStats } from './ollamaApi.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Chat parameters forwarded to the Ollama API. */
export interface StreamAIResponseParams {
    model: string;
    messages: ChatMessage[];
    tools: OllamaToolDefinition[];
    numCtx: number;
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
    /** Any tool calls the model requested. */
    toolCalls: OllamaToolCall[];
    /** True if the user interrupted the stream before it completed. */
    interrupted: boolean;
    /** Final Ollama token/duration stats when provided by the API. */
    finalStats: OllamaTurnStats | null;
}

export interface RenderTurnOptions extends StreamAIResponseOptions {
    /** Called when final authoritative stats arrive from Ollama. */
    onFinalStats?: (authoritativeTokensUsed: number, finalStats: OllamaTurnStats) => void;
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
    finalStats: OllamaTurnStats | null;
}> {
    const { onStatusUpdate, onFinalStats, timeoutMs } = opts;

    const { content, toolCalls, interrupted, finalStats } = await streamAIResponse(baseUrl, params, {
        onStatusUpdate,
        timeoutMs,
    });

    if (interrupted) {
        return { assistantMessage: null, interrupted: true, sessionTokenStats: null, finalStats };
    }

    let assistantMessage: ChatMessage;
    if (toolCalls.length > 0) {
        assistantMessage = {
            role: 'assistant',
            content,
            // Ensure a non-empty tuple type: [first, ...rest]
            tool_calls: [toolCalls[0]!, ...toolCalls.slice(1)],
        };
    } else {
        assistantMessage = {
            role: 'assistant',
            content,
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
 * Renders a pre-built AI response string to the terminal.
 *
 * Clears any live status line, prints the appropriate prefix label, renders
 * the content as markdown (sanitized), and writes a trailing newline.
 *
 * Use this for cases where you already have the complete text (e.g. a fallback
 * message).  For live model output prefer `streamAIResponse`.
 *
 * @param content          - The text to display.
 * @param opts.interrupted - When true, uses the "(interrupted)" label variant.
 */
export function printAIResponse(
    content: string,
    opts?: { interrupted?: boolean },
): void {
    clearLiveStatus();
    const label = opts?.interrupted
        ? chalk.yellow('\nAI (interrupted) > ')
        : chalk.yellow('\nAI > ');
    process.stdout.write(label);
    process.stdout.write(renderMarkdown(sanitize(content)));
    process.stdout.write('\n');
}

/**
 * Streams an AI response and shows a live character count on the status line.
 *
 * Opens the Ollama chat stream internally, wires up the interrupt handler, and
 * updates the status line with `"AI is responding... (N chars)"` as each chunk
 * arrives.  No raw text is written to the terminal during this phase.  Once the
 * stream is complete (or interrupted), the full accumulated response is rendered
 * as formatted markdown via `printAIResponse`.
 *
 * Tool-call-only responses (no text content) produce no terminal output.
 *
 * @param baseUrl - Ollama base URL (e.g. `http://localhost:11434`).
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
    const toolCalls: OllamaToolCall[] = [];
    let interrupted = false;
    let finalStats: OllamaTurnStats | null = null;

    onStatusUpdate('AI is responding...');

    const abortController = new AbortController();

    registerInterruptHandler(() => abortController.abort());

    const stream = sendOllamaChatStream(baseUrl, {
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        numCtx: params.numCtx,
        signal: abortController.signal,
        timeoutMs: opts.timeoutMs,
    });

    try {
        for await (const chunk of stream) {
            if (isInterruptRequested()) {
                interrupted = true;
                abortController.abort();
                break;
            }

            const chunkContent = chunk.message?.content ?? '';
            if (chunkContent.length > 0) {
                content += chunkContent;
                onStatusUpdate(`AI is responding... (${content.length} chars)`);
            }

            if (chunk.message?.tool_calls) {
                toolCalls.push(...chunk.message.tool_calls);
            }

            if (chunk.done) {
                finalStats = getOllamaTurnStats(chunk);
            }
        }
    } catch (error) {
        if (!isInterruptRequested()) throw error;
        interrupted = true;
    } finally {
        unregisterInterruptHandler();
    }

    if (content.trim().length > 0) {
        printAIResponse(content, { interrupted });
    }

    return { content, toolCalls, interrupted, finalStats };
}
