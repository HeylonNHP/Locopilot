/**
 * services/promptLoop.ts
 *
 * Prompt-loop completeness judge. After the LLM finishes a turn without tool
 * calls, this helper asks the same model a short YES/NO question to determine
 * whether the user's original request was actually satisfied.
 *
 * Modeled on `services/errorSummary.ts` — same shape, same defensive error
 * handling, same use of `sendLlmChat` (non-streaming).
 */

import { sendLlmChat } from './llm';
import type { ChatMessage } from './llm';

const JUDGE_SYSTEM_PROMPT =
    'You are a completeness checker. Your only job is to determine whether ' +
    'a task was fully completed by the assistant.\n\n' +
    'Reply with ONLY the word YES or NO on the first line.\n\n' +
    'YES — the user\'s original request was fully satisfied. Nothing is missing.\n' +
    'NO  — something is missing, incomplete, or the assistant stopped early.';

/**
 * Asks the LLM to judge whether the user's original request was satisfied
 * by the assistant's reply.
 *
 * @param baseUrl        - Ollama base URL
 * @param model          - Model name (same model used for the main turn)
 * @param numCtx         - Context window size
 * @param userRequest    - The user's original prompt for this turn
 * @param assistantReply - The assistant's (presumed) final response
 * @param signal         - AbortSignal from the HTTP request
 * @returns true if the task is satisfied, false otherwise. Returns true only
 *          when the judge's answer explicitly starts with 'YES'; everything
 *          else (including 'NO', ambiguous text, or empty responses) is
 *          treated as NOT satisfied so the prompt loop continues. On a
 *          thrown exception (network/model failure) returns true to prevent
 *          an infinite loop.
 */
export async function checkCompleteness(
    baseUrl: string,
    model: string,
    numCtx: number,
    userRequest: string,
    assistantReply: string,
    signal?: AbortSignal,
): Promise<boolean> {
    const messages: ChatMessage[] = [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        {
            role: 'user',
            content:
                `ORIGINAL REQUEST:\n${userRequest}\n\n` +
                `ASSISTANT REPLY:\n${assistantReply}\n\n` +
                `Is the request fully satisfied? Reply YES or NO.`,
        },
    ];

    try {
        const response = await sendLlmChat(baseUrl, {
            model,
            messages,
            tools: [] as import('./adapters/llmAdapter').ToolDefinition[],
            numCtx,
            think: false,
            options: { temperature: 0 },
            ...(signal ? { signal } : {}),
        });

        const answer = (response.message.content ?? '').trim().toUpperCase();
        if (response.message.thinking) {
            console.log(
                `[prompt-loop] Judge thinking: "${response.message.thinking.slice(0, 200)}"`,
            );
        }
        if (!answer) {
            console.warn('[prompt-loop] Judge returned empty content — treating as NOT satisfied');
        }
        const satisfied = answer.startsWith('YES');
        console.log(
            `[prompt-loop] Judge answer: "${answer.slice(0, 80)}" → ${satisfied ? 'satisfied' : 'NOT satisfied'}`,
        );
        return satisfied;
    } catch (err) {
        // Judge call failed (network, model crash, etc.). Log and treat as
        // satisfied so a transient infrastructure error doesn't infinite-loop.
        console.error(
            `[prompt-loop] Judge call failed: ${err instanceof Error ? err.message : String(err)} — treating as satisfied to avoid infinite loop`,
        );
        return true;
    }
}
