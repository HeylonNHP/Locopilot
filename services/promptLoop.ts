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

const CRITIC_SYSTEM_PROMPT =
    'You are a quality assurance reviewer. A completeness check determined that an AI assistant\'s reply did NOT fully satisfy the user\'s original request.\n\n' +
    'Explain specifically what is missing, incomplete, or incorrect in the assistant\'s reply. Be precise and actionable — your explanation will be shown to the assistant so it can improve its next attempt.\n\n' +
    'Focus on concrete deficiencies (e.g., "the reply omitted error handling", "the code does not handle the edge case where X is empty", "the explanation did not cover Y"). Avoid vague statements like "not thorough enough" — say what is actually absent.';

/**
 * Asks the LLM to explain what is missing or incomplete in the assistant's
 * reply. Called only when the classifier returns NO.
 *
 * @param baseUrl        - Ollama base URL
 * @param model          - Model name (same model used for the main turn)
 * @param numCtx         - Context window size
 * @param userRequest    - The user's original prompt for this turn
 * @param assistantReply - The assistant's (presumed) final response
 * @param signal         - AbortSignal from the HTTP request
 * @returns An object containing the feedback string (may be empty).
 */
export async function generateJudgeFeedback(
    baseUrl: string,
    model: string,
    numCtx: number,
    userRequest: string,
    assistantReply: string,
    signal?: AbortSignal,
): Promise<{ feedback: string }> {
    const messages: ChatMessage[] = [
        { role: 'system', content: CRITIC_SYSTEM_PROMPT },
        {
            role: 'user',
            content:
                `ORIGINAL REQUEST:\n${userRequest}\n\n` +
                `ASSISTANT REPLY:\n${assistantReply}\n\n` +
                `Explain specifically what is missing, incomplete, or incorrect in the assistant's reply.`,
        },
    ];

    try {
        const response = await sendLlmChat(baseUrl, {
            model,
            messages,
            tools: [] as import('./adapters/llmAdapter').ToolDefinition[],
            numCtx,
            options: { temperature: 0.3 },
            ...(signal ? { signal } : {}),
        });

        let feedback = (response.message.content ?? '').trim();
        if (response.message.thinking) {
            console.log(
                `[prompt-loop] Critic thinking: "${response.message.thinking.slice(0, 300)}"`,
            );
        }
        if (!feedback) {
            console.warn('[prompt-loop] Critic returned empty content');
        }
        // Cap at 600 characters, cutting at the last word boundary to avoid
        // mid-sentence truncation.
        if (feedback.length > 600) {
            const lastSpace = feedback.lastIndexOf(' ', 600);
            feedback = feedback.slice(0, lastSpace > 0 ? lastSpace : 600) + '…';
        }
        console.log(
            `[prompt-loop] Critic feedback: "${feedback.slice(0, 80)}${feedback.length > 80 ? '...' : ''}"`,
        );
        return { feedback };
    } catch (err) {
        console.error(
            `[prompt-loop] Critic call failed: ${err instanceof Error ? err.message : String(err)} — returning empty feedback`,
        );
        return { feedback: '' };
    }
}

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
 * @returns An object with `satisfied` set to true if the task is satisfied.
 *          Returns satisfied=true only when the judge's answer explicitly
 *          starts with 'YES'; everything else is treated as NOT satisfied.
 *          On a thrown exception (network/model failure) returns
 *          { satisfied: true } to prevent an infinite loop.
 */
export async function checkCompleteness(
    baseUrl: string,
    model: string,
    numCtx: number,
    userRequest: string,
    assistantReply: string,
    signal?: AbortSignal,
): Promise<{ satisfied: boolean; feedback?: string }> {
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
            options: { temperature: 0 },
            ...(signal ? { signal } : {}),
        });

        const answer = (response.message.content ?? '').trim().toUpperCase();
        if (response.message.thinking) {
            console.log(
                `[prompt-loop] Judge thinking: "${response.message.thinking.slice(0, 300)}"`,
            );
        }
        if (!answer) {
            console.warn('[prompt-loop] Judge returned empty content — treating as NOT satisfied');
        }
        const satisfied = answer.startsWith('YES');
        console.log(
            `[prompt-loop] Judge answer: "${answer.slice(0, 80)}" → ${satisfied ? 'satisfied' : 'NOT satisfied'}`,
        );

        if (!satisfied) {
            const { feedback } = await generateJudgeFeedback(
                baseUrl,
                model,
                numCtx,
                userRequest,
                assistantReply,
                signal,
            );
            return { satisfied: false, feedback };
        }

        return { satisfied: true };
    } catch (err) {
        // Propagate user aborts so the outer route can clean up correctly.
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
        }
        // Judge call failed (network, model crash, etc.). Log and treat as
        // satisfied so a transient infrastructure error doesn't infinite-loop.
        console.error(
            `[prompt-loop] Judge call failed: ${err instanceof Error ? err.message : String(err)} — treating as satisfied to avoid infinite loop`,
        );
        return { satisfied: true };
    }
}
