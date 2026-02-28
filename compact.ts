/**
 * compact.ts
 *
 * Provides the /compact command for Locopilot.
 *
 * Sends the current conversation history to the LLM and asks it to produce a
 * concise summary that preserves all important context. The resulting summary
 * replaces the live message history so that future turns consume less of the
 * model's context window. A preamble is injected into the summarised history
 * so the model understands it is receiving a condensed record rather than a
 * verbatim transcript.
 */

import chalk from 'chalk';
import { sendOllamaChatStream } from './ollamaApi.js';
import type { ChatMessage } from './ollamaApi.js';
import { countMessagesTokens } from './tokenizer.js';

// The instruction sent to the LLM when asking it to compact the history.
const COMPACT_SYSTEM_PROMPT =
    'You are a conversation summariser. You will be given the full history of a ' +
    'chat session between a user and an AI assistant. Your task is to produce a ' +
    'single, concise summary of that history that:\n' +
    '  1. Retains every decision, fact, file path, code snippet, command, result, ' +
    'and piece of context that could affect future responses.\n' +
    '  2. Strips away conversational filler, repeated confirmations, and any ' +
    'content that carries no lasting informational value.\n' +
    '  3. Is written in the third person (e.g. "The user asked… The assistant ' +
    'explained… A command was run and returned…").\n' +
    '  4. Is always shorter than the original history.\n' +
    'Return ONLY the summary text — no headings, no markdown, no commentary.';

// Preamble injected at the start of the compacted history so the model knows
// it is reading a summary rather than a live transcript.
const SUMMARY_PREAMBLE =
    '[This conversation history has been compacted. What follows is a concise ' +
    'summary of everything important that has occurred so far. Treat it as ' +
    'authoritative context for continuing the conversation.]';

export interface CompactResult {
    /** The new, compacted message array that should replace the live history. */
    newMessages: ChatMessage[];
    /** Token counts for display purposes. */
    stats: {
        oldTokenCount: number;
        newTokenCount: number;
    };
}

/**
 * Compacts the provided conversation history by asking the LLM to summarise
 * it. Returns the new message array and stats comparing old vs new sizes.
 *
 * @param baseUrl   - Ollama base URL (e.g. http://localhost:11434)
 * @param model     - Model name to use for summarisation
 * @param messages  - Current conversation history (should include system prompt)
 * @param numCtx    - Context length to pass to the API
 * @param onProgress - Optional callback for live progress updates
 */
export async function compactHistory(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    numCtx: number,
    onProgress?: (message: string) => void,
): Promise<CompactResult> {
    const oldTokenCount = countMessagesTokens(messages, model);

    // Separate the system prompt from the rest of the history so we can
    // preserve it verbatim in the compacted result.
    const systemMessage = messages[0];
    if (!systemMessage) {
        throw new Error('Cannot compact an empty message history.');
    }
    const historyMessages = messages.slice(1);

    // Build a single user turn that presents the history to the summariser.
    const historyText = historyMessages
        .map(m => `[${m.role.toUpperCase()}]: ${m.content ?? ''}`)
        .join('\n\n');

    const summarisationMessages: ChatMessage[] = [
        { role: 'system', content: COMPACT_SYSTEM_PROMPT },
        {
            role: 'user',
            content:
                'Please summarise the following conversation history:\n\n' +
                historyText,
        },
    ];

    let summary = '';
    for await (const chunk of sendOllamaChatStream(baseUrl, {
        model,
        messages: summarisationMessages,
        tools: [],   // No tools needed for summarisation
        numCtx,
    })) {
        const content = chunk.message.content ?? '';
        if (content.length > 0) {
            summary += content;
            onProgress?.(`AI is summarizing... (${summary.length} chars)`);
        }
    }

    summary = summary.trim();

    if (!summary) {
        throw new Error('The model returned an empty summary. Compaction aborted.');
    }

    // Rebuild the message history: original system prompt + a single assistant
    // message that holds the preamble + summary.
    const newMessages: ChatMessage[] = [
        systemMessage,
        {
            role: 'assistant',
            content: `${SUMMARY_PREAMBLE}\n\n${summary}`,
        },
    ];

    const newTokenCount = countMessagesTokens(newMessages, model);

    return {
        newMessages,
        stats: {
            oldTokenCount,
            newTokenCount,
        },
    };
}

/**
 * Prints a human-readable compaction report to the terminal.
 */
export function printCompactStats(stats: CompactResult['stats']): void {
    const tokensSaved = stats.oldTokenCount - stats.newTokenCount;
    const ratio = stats.oldTokenCount > 0
        ? ((tokensSaved / stats.oldTokenCount) * 100).toFixed(1)
        : '0.0';

    console.log(chalk.green('\n── Compaction complete ──────────────────────────'));
    console.log(
        chalk.white('  Tokens   : ') +
        chalk.red(String(stats.oldTokenCount)) +
        chalk.white(' → ') +
        chalk.green(String(stats.newTokenCount)) +
        chalk.dim(` (−${tokensSaved} tokens, ${ratio}% reduction)`),
    );
    console.log(chalk.green('─────────────────────────────────────────────────\n'));
}
