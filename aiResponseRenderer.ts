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
 *                       the HTTP stream, manages the interrupt handler, writes
 *                       each text chunk directly to the terminal as it arrives
 *                       (true streaming output — no buffering), and returns the
 *                       accumulated content + tool calls + interrupted flag to
 *                       the caller.  The caller only needs to supply the chat
 *                       parameters and a status-update callback.
 */

import chalk from 'chalk';
import { renderMarkdown } from './markdownRenderer.js';
import { clearLiveStatus } from './statusLine.js';
import {
    sanitize,
    isInterruptRequested,
    registerInterruptHandler,
    unregisterInterruptHandler,
} from './tools.js';
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
 * Streams an AI response directly to the terminal as it arrives.
 *
 * Opens the Ollama chat stream internally, wires up the interrupt handler, and
 * writes each content chunk to stdout the moment it is received — the user sees
 * the model "type" in real time.  When the stream ends (or is interrupted) a
 * final newline is written and the function returns.
 *
 * The `"AI is responding..."` status is set at the start; the char-count
 * suffix is kept up-to-date via `onStatusUpdate` while streaming proceeds.
 *
 * Tool-call-only responses (no text content) produce no terminal output.
 *
 * Post-stream re-render strategy:
 *   - SHORT responses (streamed lines < terminal height): cursor moves back
 *     to the "AI > " header line with \x1B[{N}A, the raw text is erased, and
 *     the formatted markdown replaces it.  This works because the content never
 *     scrolled the viewport so the header row is still reachable.
 *   - LONG responses (scrolled off the top of the viewport): the raw stream is
 *     left in the scrollback buffer and the formatted version is printed below,
 *     separated by a dim rule.  This avoids the half-erase artefact that occurs
 *     when \x1B[{N}A is capped at the top of the visible screen.
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
    let headerPrinted = false;
    let finalStats: OllamaTurnStats | null = null;

    // Count visual lines emitted during streaming so we can step back precisely
    // for the post-stream re-render.  Only reliable when the response does NOT
    // scroll the terminal (i.e. streamedLines < terminal height).  We start at 1
    // for the "AI > " header line and track column position to detect soft-wraps.
    const termWidth = process.stdout.isTTY ? (process.stdout.columns || 80) : 80;
    const termHeight = process.stdout.isTTY ? (process.stdout.rows || 24) : 24;
    const AI_LABEL_VISIBLE_LEN = 'AI > '.length;
    let streamedLines = 1;
    let currentLineLen = AI_LABEL_VISIBLE_LEN;

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
                if (!headerPrinted) {
                    clearLiveStatus();
                    process.stdout.write(chalk.yellow('\nAI > '));
                    headerPrinted = true;
                }
                content += chunkContent;
                process.stdout.write(chunkContent);

                if (process.stdout.isTTY) {
                    for (const char of chunkContent) {
                        if (char === '\n') {
                            streamedLines++;
                            currentLineLen = 0;
                        } else if (++currentLineLen >= termWidth) {
                            streamedLines++;
                            currentLineLen = 0;
                        }
                    }
                }
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

    if (headerPrinted) {
        if (interrupted) {
            // Append an inline note so the user can see the stream was cut short.
            process.stdout.write(chalk.yellow(' (interrupted)'));
            process.stdout.write('\n');
        } else if (process.stdout.isTTY && content.trim().length > 0) {
            const rendered = renderMarkdown(sanitize(content));

            if (streamedLines < termHeight) {
                // SHORT response: the entire streamed output is still within the
                // visible viewport.  \x1B[{N}A reliably reaches the header row,
                // so we erase and replace with formatted markdown.
                process.stdout.write(`\x1B[${streamedLines}A`); // cursor up to header row
                process.stdout.write('\x1B[G');                 // column 0
                process.stdout.write('\x1B[J');                 // clear to end of screen
                process.stdout.write(chalk.yellow('AI > '));
                process.stdout.write(rendered);
            } else {
                // LONG response: the content scrolled the terminal.  \x1B[{N}A
                // would be capped at the top of the visible viewport, leaving the
                // raw stream partially visible above a half-erased re-render.
                // Instead, leave the raw stream in the scrollback buffer and print
                // the formatted version below, clearly separated.
                process.stdout.write('\n');
                process.stdout.write(chalk.dim('─'.repeat(termWidth)));
                process.stdout.write('\n');
                process.stdout.write(chalk.yellow('AI > '));
                process.stdout.write(rendered);
            }
        } else {
            process.stdout.write('\n');
        }
    }

    return { content, toolCalls, interrupted, finalStats };
}
