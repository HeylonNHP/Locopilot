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
import { sendOllamaChat } from './ollamaApi.js';
import type { ChatMessage } from './ollamaApi.js';

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
    /** Token/character counts for display purposes. */
    stats: {
        oldCharCount: number;
        newCharCount: number;
        oldMessageCount: number;
        newMessageCount: number;
    };
}

/**
 * Counts the total characters across all message content fields.
 */
function totalChars(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
}

/**
 * Compacts the provided conversation history by asking the LLM to summarise
 * it. Returns the new message array and stats comparing old vs new sizes.
 *
 * @param baseUrl   - Ollama base URL (e.g. http://localhost:11434)
 * @param model     - Model name to use for summarisation
 * @param messages  - Current conversation history (should include system prompt)
 * @param numCtx    - Context length to pass to the API
 */
export async function compactHistory(
    baseUrl: string,
    model: string,
    messages: ChatMessage[],
    numCtx: number,
): Promise<CompactResult> {
    const oldCharCount = totalChars(messages);
    const oldMessageCount = messages.length;

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

    console.log(chalk.dim('\nRequesting summary from model — please wait...\n'));

    const response = await sendOllamaChat(baseUrl, {
        model,
        messages: summarisationMessages,
        tools: [],   // No tools needed for summarisation
        numCtx,
    });

    const summary = response.message.content?.trim() ?? '';

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

    const newCharCount = totalChars(newMessages);
    const newMessageCount = newMessages.length;

    return {
        newMessages,
        stats: {
            oldCharCount,
            newCharCount,
            oldMessageCount,
            newMessageCount,
        },
    };
}

/**
 * Prints a human-readable compaction report to the terminal.
 */
export function printCompactStats(stats: CompactResult['stats']): void {
    const charSaved = stats.oldCharCount - stats.newCharCount;
    const ratio = stats.oldCharCount > 0
        ? ((charSaved / stats.oldCharCount) * 100).toFixed(1)
        : '0.0';

    console.log(chalk.green('\n── Compaction complete ──────────────────────────'));
    console.log(
        chalk.white('  Messages : ') +
        chalk.red(String(stats.oldMessageCount)) +
        chalk.white(' → ') +
        chalk.green(String(stats.newMessageCount)),
    );
    console.log(
        chalk.white('  Chars    : ') +
        chalk.red(String(stats.oldCharCount)) +
        chalk.white(' → ') +
        chalk.green(String(stats.newCharCount)) +
        chalk.dim(` (−${charSaved} chars, ${ratio}% reduction)`),
    );
    console.log(chalk.green('─────────────────────────────────────────────────\n'));
}
