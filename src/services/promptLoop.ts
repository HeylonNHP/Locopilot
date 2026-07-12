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

import type { ToolDefinition } from './adapters/llmAdapter';

import { logger } from '../app/lib/logger';
import { type ChatMessage, type LlmRequestContext, sendLlmChat } from './llm';

const JUDGE_SYSTEM_PROMPT =
  'You are a completeness checker. Your only job is to determine whether ' +
  'a task was fully completed by the assistant.\n\n' +
  'You will receive the original request, a trace of actions taken by the assistant ' +
  "(tool calls, thinking, intermediate results), and the assistant's final reply. " +
  'Consider the FULL set of actions — not just the final reply text. ' +
  'If the assistant performed the requested work through tool calls, code edits, ' +
  'or other actions visible in the trace, consider the request satisfied even if ' +
  'the final reply is brief.\n\n' +
  'However, be alert for cases where the final reply is clearly unfinished — ' +
  'for example, ending mid-sentence, trailing off with Let me... or I will... ' +
  'without actually completing the action, or making a plan but never executing it. ' +
  'This often happens when a small model stops early: the thinking traces and tool calls ' +
  'show progress but the final reply makes it obvious the task was abandoned partway through. ' +
  'In these cases the reply is NOT satisfactory, even if some work was done.\n\n' +
  'Reply with ONLY the word YES or NO on the first line.\n\n' +
  "YES — the user's original request was fully satisfied. Nothing is missing.\n" +
  'NO  — something is missing, incomplete, or the assistant stopped early.';

const CRITIC_SYSTEM_PROMPT =
  "You are a quality assurance reviewer. A completeness check determined that an AI assistant's reply did NOT fully satisfy the user's original request.\n\n" +
  'You will also see a trace of actions the assistant took (tool calls, thinking, intermediate results). ' +
  'Consider both the action trace AND the final reply when identifying what is missing.\n\n' +
  'Explain specifically what is missing, incomplete, or incorrect. Be precise and actionable — your explanation will be shown to the assistant so it can improve its next attempt.\n\n' +
  'Focus on concrete deficiencies (e.g., "the reply omitted error handling", "the code does not handle the edge case where X is empty", "the explanation did not cover Y"). Avoid vague statements like "not thorough enough" — say what is actually absent. Keep your critique concise — roughly 1-3 sentences, or about 1000 characters at most. A short, targeted explanation helps the assistant fix the issue faster than a lengthy review. Focus on what\'s missing, not what\'s present.';

/**
 * Formats intermediate ChatMessages (tool calls, thinking, tool results)
 * into a human-readable trace section for the judge and critic prompts.
 * No truncation — full fidelity is preferred over token savings.
 */
function formatTraceSection(traceMessages: ChatMessage[]): string {
  if (traceMessages.length === 0) return '';
  const lines: string[] = [];
  for (const msg of traceMessages) {
    if (msg.role === 'assistant') {
      if (msg.thinking) {
        lines.push(`💡 Thinking: ${msg.thinking}`);
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let argsStr: string;
          if (typeof tc.function.arguments === 'string') {
            argsStr = tc.function.arguments;
          } else {
            // Guard against circular structures / BigInt / etc.
            // that would otherwise throw and (silently) be
            // treated as a satisfied reply by the caller.
            try {
              argsStr = JSON.stringify(tc.function.arguments, null, 2);
            } catch {
              argsStr = '[unserializable arguments]';
            }
          }
          lines.push(`🔧 Tool call: ${tc.function.name}(${argsStr})`);
        }
      }
      // Include non-empty content (but not if it's the final reply — that's already in assistantReply)
      if (msg.content && msg.content.trim() && !msg.tool_calls) {
        lines.push(`💬 Assistant: ${msg.content}`);
      }
    } else if (msg.role === 'tool') {
      const content = msg.content ?? '<empty>';
      lines.push(`📋 Tool result: ${content}`);
    }
    // Skip 'system' and 'user' messages in the trace
  }
  if (lines.length === 0) return '';
  return `ACTIONS TAKEN (tool calls, thinking, and intermediate results):\n${  lines.join('\n')}`;
}

/**
 * Asks the LLM to explain what is missing or incomplete in the assistant's
 * reply. Called only when the classifier returns NO.
 *
 * @param ctx             - Per-request LLM context (provider, baseUrl, apiKey).
 * @param model           - Model name (same model used for the main turn)
 * @param numCtx          - Context window size
 * @param userRequest     - The user's original prompt for this turn
 * @param assistantReply  - The assistant's (presumed) final response
 * @param traceMessages   - Intermediate messages (tool calls, thinking, results) between the user request and final reply
 * @param signal          - AbortSignal from the HTTP request
 * @returns An object containing the feedback string (may be empty).
 */
export async function generateJudgeFeedback(
  ctx: LlmRequestContext,
  model: string,
  numCtx: number,
  userRequest: string,
  assistantReply: string,
  traceMessages?: ChatMessage[],
  signal?: AbortSignal
): Promise<{ feedback: string }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: CRITIC_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `ORIGINAL REQUEST:\n${userRequest}\n\n${
        traceMessages && traceMessages.length > 0
          ? `${formatTraceSection(traceMessages)  }\n\n`
          : ''
        }ASSISTANT REPLY:\n${assistantReply}\n\n` +
        `Explain specifically what is missing, incomplete, or incorrect in the assistant's reply.`,
    },
  ];

  try {
    const response = await sendLlmChat(ctx, {
      model,
      messages,
      tools: [] as ToolDefinition[],
      numCtx,
      options: { temperature: 0.3 },
      ...(signal ? { signal } : {}),
    });

    const feedback = (response.message.content ?? '').trim();
    if (response.message.thinking) {
      logger.info('prompt-loop', 'Critic thinking', {
        thinking: response.message.thinking.slice(0, 300),
      });
    }
    logger.info('prompt-loop', 'Critic feedback', {
      preview: feedback.slice(0, 80),
      truncated: feedback.length > 80,
      length: feedback.length,
    });
    return { feedback };
  } catch (err) {
    // Propagate user aborts so the outer route can clean up correctly.
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    logger.error('prompt-loop', 'Critic call failed — returning empty feedback', { error: err });
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
 * @param traceMessages  - Intermediate messages (tool calls, thinking, results) between the user request and final reply
 * @param signal         - AbortSignal from the HTTP request
 * @returns An object with `satisfied` set to true if the task is satisfied.
 *          Returns satisfied=true only when the judge's answer explicitly
 *          starts with 'YES'; everything else is treated as NOT satisfied.
 *          Thrown exceptions (network/model failure or user abort) are
 *          propagated to the caller so they are not silently misclassified
 *          as a satisfied reply.
 */
export async function checkCompleteness(
  ctx: LlmRequestContext,
  model: string,
  numCtx: number,
  userRequest: string,
  assistantReply: string,
  traceMessages?: ChatMessage[],
  signal?: AbortSignal
): Promise<{ satisfied: boolean; feedback?: string }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `ORIGINAL REQUEST:\n${userRequest}\n\n${
        traceMessages && traceMessages.length > 0
          ? `${formatTraceSection(traceMessages)  }\n\n`
          : ''
        }ASSISTANT REPLY:\n${assistantReply}\n\n` +
        `Is the request fully satisfied? Reply YES or NO.`,
    },
  ];

  try {
    const response = await sendLlmChat(ctx, {
      model,
      messages,
      tools: [] as ToolDefinition[],
      numCtx,
      options: { temperature: 0 },
      ...(signal ? { signal } : {}),
    });

    const answer = (response.message.content ?? '').trim().toUpperCase();
    if (response.message.thinking) {
      logger.info('prompt-loop', 'Judge thinking', {
        thinking: response.message.thinking.slice(0, 300),
      });
    }
    if (!answer) {
      logger.warn('prompt-loop', 'Judge returned empty content — treating as NOT satisfied');
    }
    const satisfied = answer.startsWith('YES');
    logger.info('prompt-loop', 'Judge answer', { answer: answer.slice(0, 80), satisfied });

    if (!satisfied) {
      const { feedback } = await generateJudgeFeedback(
        ctx,
        model,
        numCtx,
        userRequest,
        assistantReply,
        traceMessages,
        signal
      );
      return { satisfied: false, feedback };
    }

    return { satisfied: true };
  } catch (err) {
    // Propagate all failures to the caller. Returning satisfied=true on a
    // network/model error would hide the failure from the user and could
    // emit an incomplete answer; letting the route catch surface it as an
    // SSE error is safer.
    logger.error('prompt-loop', 'checkCompleteness error', { error: err });
    throw err;
  }
}
