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
import { sendOllamaChatStream } from './ollamaApi.js';
import type { OllamaToolCall, OllamaToolDefinition, ChatMessage } from './ollamaApi.js';

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
}

export interface StreamAIResponseResult {
    /** Full accumulated text content from the model. */
    content: string;
    /** Any tool calls the model requested. */
    toolCalls: OllamaToolCall[];
    /** True if the user interrupted the stream before it completed. */
    interrupted: boolean;
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

    onStatusUpdate('AI is responding...');

    const abortController = new AbortController();

    registerInterruptHandler(() => {
        abortController.abort();
    });

    const stream = sendOllamaChatStream(baseUrl, {
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        numCtx: params.numCtx,
        signal: abortController.signal,
    });

    try {
        for await (const chunk of stream) {
            if (isInterruptRequested()) {
                interrupted = true;
                abortController.abort();
                break;
            }

            const chunkContent = chunk.message.content ?? '';
            if (chunkContent.length > 0) {
                if (!headerPrinted) {
                    // Kill the status-line timer before writing any content.
                    // draw() uses readline.cursorTo(0) + clearLine(0) which targets
                    // the *current* line — if we leave the timer running it will
                    // overwrite the streamed AI text every 120 ms.
                    clearLiveStatus();
                    process.stdout.write(chalk.yellow('\nAI > '));
                    headerPrinted = true;
                }
                content += chunkContent;
                process.stdout.write(chunkContent);
                // Do NOT call onStatusUpdate here — restarting the timer while
                // content is mid-line would cause the status draw to erase it.
            }

            if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
                toolCalls.push(...chunk.message.tool_calls);
            }
        }
    } catch (error) {
        if (isInterruptRequested()) {
            interrupted = true;
        } else {
            throw error;
        }
    } finally {
        unregisterInterruptHandler();
    }

    if (headerPrinted) {
        if (interrupted) {
            // Append an inline note so the user can see the stream was cut short.
            process.stdout.write(chalk.yellow(' (interrupted)'));
        }
        process.stdout.write('\n');
    }

    return { content, toolCalls, interrupted };
}
