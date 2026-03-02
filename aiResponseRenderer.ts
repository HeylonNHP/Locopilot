/**
 * aiResponseRenderer.ts
 *
 * Centralised helpers for rendering AI responses in the terminal.
 *
 * `printAIResponse`   – synchronously prints a finished AI message with the
 *                       correct prefix label, markdown rendering, and status
 *                       line cleanup.
 *
 * `streamAIResponse`  – consumes an Ollama streaming response, shows live
 *                       progress on the status line, wires up the interrupt
 *                       handler, and delegates final rendering to
 *                       `printAIResponse`.  Returns the accumulated content,
 *                       tool calls, and whether the stream was cut short.
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
import type { ChatApiResponse, OllamaToolCall } from './ollamaApi.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StreamAIResponseOptions {
    /** AbortController whose `.abort()` is called on interrupt. */
    abortController: AbortController;
    /**
     * Callback invoked after each content chunk.  Receives a human-readable
     * phase string such as `"AI is responding... (342 chars)"`.  Typically
     * wired to `refreshTokenStatus`.
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
 * Renders a finished AI response to the terminal.
 *
 * Clears any live status line, prints the appropriate prefix label, renders
 * the content as markdown (sanitized), and writes a trailing newline.
 *
 * @param content     - The AI's response text.
 * @param opts.interrupted - When true, prints the "(interrupted)" label variant.
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
 * Consumes an Ollama chat stream, updating the status line with progress,
 * handling user interrupts, and rendering the final output via
 * `printAIResponse`.
 *
 * The function sets the initial `"AI is responding..."` status itself so
 * callers do not need a separate `refreshTokenStatus` call before invoking it.
 *
 * Only calls `printAIResponse` when there is actual content to display — tool-
 * call-only responses (no text) are returned silently.
 *
 * @param stream - The async iterable returned by `sendOllamaChatStream`.
 * @param opts   - Abort controller and status update callback.
 * @returns Accumulated content, tool calls, and interrupted flag.
 */
export async function streamAIResponse(
    stream: AsyncIterable<ChatApiResponse>,
    opts: StreamAIResponseOptions,
): Promise<StreamAIResponseResult> {
    const { abortController, onStatusUpdate } = opts;

    let content = '';
    const toolCalls: OllamaToolCall[] = [];
    let interrupted = false;

    onStatusUpdate('AI is responding...');

    registerInterruptHandler(() => {
        abortController.abort();
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
                content += chunkContent;
                onStatusUpdate(`AI is responding... (${content.length} chars)`);
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

    if (content.trim().length > 0) {
        printAIResponse(content, { interrupted });
    }

    return { content, toolCalls, interrupted };
}
