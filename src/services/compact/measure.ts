/**
 * measure.ts
 *
 * Token measurement for the compaction pipeline. Prefers a live LLM call with
 * an inflated context window (so a near-full history does not 400) and falls
 * back to the local tiktoken estimate if the API measurement fails.
 */

import {
  type ChatMessage,
  getLlmTurnStats,
  type LlmRequestContext,
  sendLlmChat,
} from '@/services/llm';
import { countMessagesTokens } from '@/services/tokenizer';

const MEASUREMENT_CTX_MULTIPLIER = 2;
const MEASUREMENT_CTX_FLOOR = 32768;

export async function measureConversationTokens(
  ctx: LlmRequestContext,
  messages: ChatMessage[],
  model: string,
  numCtx: number,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<number> {
  onProgress?.('Measuring conversation tokens...');

  try {
    // Use a significantly larger context window for the measurement call to
    // avoid Status 400 errors when the history is already at 100% capacity.
    const measurementCtx = Math.max(numCtx * MEASUREMENT_CTX_MULTIPLIER, MEASUREMENT_CTX_FLOOR);

    const response = await sendLlmChat(
      ctx,
      {
        model,
        messages,
        tools: [],
        numCtx: measurementCtx,
        maxOutputTokens: 1, // Minimize generation overhead during measurement.
        options: {
          temperature: 0,
        },
      },
      undefined,
      undefined,
      signal
    );

    const stats = getLlmTurnStats(ctx, response);
    if (stats) {
      return stats.promptEvalCount + stats.evalCount;
    }
  } catch {
    // If the API call fails (e.g. backend is very strict), fall back to the
    // local tiktoken estimate instead of crashing.
    onProgress?.('API measurement failed; falling back to local estimate...');
  }

  return countMessagesTokens(messages, model);
}
