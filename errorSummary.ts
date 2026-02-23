/**
 * errorSummary.ts
 *
 * Provides a utility to use the LLM to summarize shell command failures.
 * This helps users quickly understand why a command failed by distilling
 * technical stderr output into a brief, human-readable summary.
 */

import { sendOllamaChat } from './ollamaApi.js';
import type { ChatMessage } from './ollamaApi.js';

const ERROR_SUMMARY_SYSTEM_PROMPT =
    'You are a technical support assistant. You will be given the output and exit code of a failed terminal command. ' +
    'Your goal is to provide a very brief (1-2 sentences) summary of why the command failed and, if obvious, a quick suggestion to fix it. ' +
    'Be concise and focus on the most likely cause. Do not use conversational filler. ' +
    'If the error is empty or unclear, just say you cannot determine the cause.';

/**
 * Uses the LLM to briefly summarize a command failure.
 *
 * @param baseUrl - Ollama base URL
 * @param model   - Model name to use
 * @param toolResult - The full string returned by the failed tool call
 * @param numCtx  - Context length
 */
export async function summarizeCommandError(
    baseUrl: string,
    model: string,
    toolResult: string,
    numCtx: number,
): Promise<string> {
    const summarizationMessages: ChatMessage[] = [
        { role: 'system', content: ERROR_SUMMARY_SYSTEM_PROMPT },
        {
            role: 'user',
            content: `A command failed with the following output:\n\n${toolResult}\n\nPlease summarize this error briefly.`,
        },
    ];

    try {
        const response = await sendOllamaChat(baseUrl, {
            model,
            messages: summarizationMessages,
            tools: [], // No tools needed for summarization
            numCtx,
        });

        return response.message.content?.trim() ?? 'No summary available.';
    } catch (err) {
        return 'Failed to generate error summary.';
    }
}
