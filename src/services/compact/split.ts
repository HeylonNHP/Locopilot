/**
 * split.ts
 *
 * History splitting for the compaction pipeline. Two responsibilities live here:
 *
 * 1. splitHistoryForCompaction — divides history into a "summarise older" slice
 *    and a "preserve recent verbatim" slice, honoring token budgets, a
 *    recent-message floor and the latest-user-message anchor.
 * 2. splitHistoryIntoChunks — splits an oversized slice into contiguous bounded
 *    chunks for the map-reduce path, keeping assistant + tool-response blocks
 *    together.
 */

import type { ChatMessage } from '@/services/llm';

import { countMessagesTokens, countMessageTokens } from '@/services/tokenizer';

import type { HistorySplit } from './types';

import { clamp } from './budget';
import {
  MIN_PRESERVED_TOKEN_BUDGET,
  MIN_SUMMARISE_TOKENS,
  MIN_TO_SUMMARISE_RATIO,
  PRESERVE_RECENT_TOKENS_RATIO,
  RECENT_TOKEN_BUDGET_CEILING_RATIO,
  RECENT_TOKEN_BUDGET_FLOOR_RATIO,
} from './constants';

function computeRecentMessageFloor(numCtx: number): number {
  return clamp(Math.round(numCtx / 32768) + 2, 2, 8);
}

/** Returns the index of the most recent `role === 'user'` message, or -1 if none. */
export function findLatestUserMessageIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/**
 * If the proposed split index would bisect an assistant message and its
 * immediate tool responses, return the index of the assistant so that the
 * entire assistant+tools block stays on the same side of the split.
 */
function adjustSplitForToolBlockIntegrity(
  historyMessages: ChatMessage[],
  splitIndex: number
): number {
  if (splitIndex <= 0 || splitIndex >= historyMessages.length) {
    return splitIndex;
  }

  let assistantIndex = -1;

  // Case 1: splitIndex points at a tool message. Walk back through consecutive
  // tool messages to find the assistant that owns this tool_call_id.
  const splitToolCallId = historyMessages[splitIndex]?.tool_call_id;
  if (splitToolCallId && historyMessages[splitIndex]?.role === 'tool') {
    for (let i = splitIndex - 1; i >= 0; i -= 1) {
      const candidate = historyMessages[i];
      if (
        candidate?.role === 'assistant' &&
        candidate?.tool_calls?.some((tc) => tc.id === splitToolCallId)
      ) {
        assistantIndex = i;
        break;
      }
      if (candidate?.role !== 'tool') {
        break;
      }
    }
  }

  // Case 2: splitIndex sits immediately after an assistant with tool_calls.
  if (assistantIndex < 0 && historyMessages[splitIndex - 1]?.role === 'assistant') {
    const assistant = historyMessages[splitIndex - 1];
    if (assistant?.tool_calls && assistant.tool_calls.length > 0) {
      assistantIndex = splitIndex - 1;
    }
  }

  if (assistantIndex < 0) {
    return splitIndex;
  }

  // Determine how far the assistant's tool responses extend.
  const assistant = historyMessages[assistantIndex];
  if (!assistant) {
    return splitIndex;
  }
  const toolCallIds = new Set(
    assistant.tool_calls?.map((tc) => tc.id).filter((id): id is string => typeof id === 'string')
  );
  if (toolCallIds.size === 0) {
    return splitIndex;
  }

  let blockEnd = assistantIndex + 1;
  while (
    blockEnd < historyMessages.length &&
    historyMessages[blockEnd]?.role === 'tool' &&
    toolCallIds.has(historyMessages[blockEnd]?.tool_call_id ?? '')
  ) {
    blockEnd += 1;
  }

  // If the block actually crosses the split, move the split to the assistant
  // so the whole block is preserved together.
  if (assistantIndex < splitIndex && blockEnd > splitIndex) {
    return assistantIndex;
  }

  return splitIndex;
}

/**
 * Splits history into a "summarise older" slice and a "preserve recent
 * verbatim" slice, honoring token budgets, a recent-message floor and the
 * latest-user-message anchor.
 */
export function splitHistoryForCompaction(
  historyMessages: ChatMessage[],
  model: string,
  numCtx: number,
  aggressiveFactor: number = 1
): HistorySplit {
  if (historyMessages.length <= 1) {
    return {
      messagesToSummarise: historyMessages,
      preservedRecentMessages: [],
      preservedRecentTokens: 0,
    };
  }

  const preserveRecentTokenBudget = clamp(
    Math.floor((numCtx * PRESERVE_RECENT_TOKENS_RATIO) / aggressiveFactor),
    Math.max(
      MIN_PRESERVED_TOKEN_BUDGET,
      Math.floor((numCtx * RECENT_TOKEN_BUDGET_FLOOR_RATIO) / aggressiveFactor)
    ),
    Math.floor((numCtx * RECENT_TOKEN_BUDGET_CEILING_RATIO) / aggressiveFactor)
  );
  const minMessagesToSummarise = Math.min(
    Math.max(1, Math.ceil(historyMessages.length * MIN_TO_SUMMARISE_RATIO)),
    historyMessages.length - 1
  );
  const maxPreservedMessages = Math.max(1, historyMessages.length - minMessagesToSummarise);
  const preserveRecentMessageFloor = Math.min(
    Math.max(1, Math.floor(computeRecentMessageFloor(numCtx) / aggressiveFactor)),
    maxPreservedMessages
  );

  const preservedFromEnd: ChatMessage[] = [];
  let preservedRecentTokens = 0;

  for (let index = historyMessages.length - 1; index >= 0; index -= 1) {
    if (index === 0) {
      break;
    }

    const message = historyMessages[index];
    if (!message) {
      continue;
    }

    if (preservedFromEnd.length >= maxPreservedMessages) {
      break;
    }

    const estimatedMessageTokens = countMessageTokens(message, model);
    const meetsFloor = preservedFromEnd.length >= preserveRecentMessageFloor;
    const meetsBudget = preservedRecentTokens >= preserveRecentTokenBudget;

    if (meetsFloor && meetsBudget) {
      break;
    }

    preservedFromEnd.push(message);
    preservedRecentTokens += estimatedMessageTokens;
  }

  const windowSplitIndex = adjustSplitForToolBlockIntegrity(
    historyMessages,
    historyMessages.length - preservedFromEnd.length
  );
  const windowPreservedMessages = historyMessages.slice(windowSplitIndex);

  // ── Latest-user-message anchor ────────────────────────────────────────
  // The most recent user message is a hard anchor: it must always appear in
  // preservedRecentMessages (verbatim) and must never be summarised.
  const latestUserIndex = findLatestUserMessageIndex(historyMessages);

  // If the anchor is already inside the preserved window (or there is no user
  // message at all), the normal result is correct — return it directly.
  if (latestUserIndex < 0 || latestUserIndex >= windowSplitIndex) {
    return {
      messagesToSummarise: historyMessages.slice(0, windowSplitIndex),
      preservedRecentMessages: windowPreservedMessages,
      preservedRecentTokens: countMessagesTokens(windowPreservedMessages, model),
    };
  }

  // The user prompt sits in the "to-summarise" portion — it must be rescued.
  const anchorMessage = historyMessages[latestUserIndex]!;
  const prePromptMessages = historyMessages.slice(0, latestUserIndex);
  const postPromptPreWindowMessages = historyMessages.slice(latestUserIndex + 1, windowSplitIndex);

  // Try A: summarise only the pre-prompt history (cleanest split).
  if (countMessagesTokens(prePromptMessages, model) >= MIN_SUMMARISE_TOKENS) {
    const preservedMessages = [anchorMessage, ...windowPreservedMessages];
    return {
      messagesToSummarise: prePromptMessages,
      preservedRecentMessages: preservedMessages,
      preservedRecentTokens: countMessagesTokens(preservedMessages, model),
    };
  }

  // Try B: pre-prompt content alone is too small. Also fold in the post-prompt
  // assistant/tool messages that sit between the anchor and the sliding-window
  // boundary. The user prompt itself is still held out verbatim.
  const combinedToSummarise = [...prePromptMessages, ...postPromptPreWindowMessages];
  if (countMessagesTokens(combinedToSummarise, model) >= MIN_SUMMARISE_TOKENS) {
    const preservedMessages = [anchorMessage, ...windowPreservedMessages];
    return {
      messagesToSummarise: combinedToSummarise,
      preservedRecentMessages: preservedMessages,
      preservedRecentTokens: countMessagesTokens(preservedMessages, model),
    };
  }

  // Fallback: still not enough. Return the pre-prompt slice; the caller's
  // MIN_SUMMARISE_TOKENS guard will decide whether to abort or expand.
  const preservedMessages = [anchorMessage, ...windowPreservedMessages];
  return {
    messagesToSummarise: prePromptMessages,
    preservedRecentMessages: preservedMessages,
    preservedRecentTokens: countMessagesTokens(preservedMessages, model),
  };
  // ── End anchor adjustment ─────────────────────────────────────────────
}

/**
 * Splits an oversized message array into contiguous chunks that each fit within
 * `safeInputBudget` tokens. A chunk never begins on a `tool` message: if the
 * next message would overflow but is a tool response, it is folded into the
 * current chunk so assistant + tool-response blocks always stay together (even
 * if that slightly exceeds the nominal budget).
 */
export function splitHistoryIntoChunks(
  messages: ChatMessage[],
  safeInputBudget: number,
  model: string
): ChatMessage[][] {
  const chunks: ChatMessage[][] = [];
  if (messages.length === 0) {
    return chunks;
  }

  let chunk: ChatMessage[] = [];
  let chunkTokens = 0;

  for (const message of messages) {
    if (!message) {
      continue;
    }
    const messageTokens = countMessageTokens(message, model);
    const wouldOverflow = chunk.length > 0 && chunkTokens + messageTokens > safeInputBudget;
    const isTool = message.role === 'tool';

    // Flush only when we are not about to start a chunk on a tool message.
    if (wouldOverflow && !isTool) {
      chunks.push(chunk);
      chunk = [];
      chunkTokens = 0;
    }

    chunk.push(message);
    chunkTokens += messageTokens;
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}
