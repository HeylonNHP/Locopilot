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
  SYNTHETIC_NUDGE_MARKER,
} from './constants';

function computeRecentMessageFloor(numCtx: number): number {
  return clamp(Math.round(numCtx / 32768) + 2, 2, 8);
}

/**
 * True when a message is a server-generated synthetic nudge rather than a
 * real user prompt. Synthetic nudges carry the shared marker prefix so this
 * check stays in sync with every injection site.
 */
export function isSyntheticNudge(message: ChatMessage | undefined): boolean {
  if (!message || message.role !== 'user') return false;
  return typeof message.content === 'string' && message.content.startsWith(SYNTHETIC_NUDGE_MARKER);
}

/** Returns the index of the most recent real (non-synthetic) `role === 'user'` message, or -1 if none. */
export function findLatestUserMessageIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user' && !isSyntheticNudge(messages[i])) return i;
  }
  return -1;
}

/**
 * The index of the assistant row that issued the tool call the tool message at
 * `toolIndex` answers, or -1 when there is none.
 *
 * The owner is looked for through the CONTIGUOUS run of tool rows that precedes
 * the message: the first assistant row reached either holds a call with the
 * message's `tool_call_id` or ends the search, and any other role ends it too.
 * -1 therefore covers a message with no id, an id nobody issued, and an owner
 * that is not adjacent (a user turn in between).
 *
 * A malformed entry in a persisted `tool_calls` array (`null`) is "not the
 * call", never a throw: the arrays are whatever the model emitted.
 */
export function findOwningAssistantIndex(
  messages: readonly ChatMessage[],
  toolIndex: number
): number {
  if (toolIndex <= 0) return -1;
  const toolCallId = messages[toolIndex]?.tool_call_id;
  if (!toolCallId) return -1;
  for (let i = toolIndex - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.role === 'assistant') {
      return candidate.tool_calls?.some((tc) => tc?.id === toolCallId) ? i : -1;
    }
    if (candidate?.role !== 'tool') return -1;
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
  if (historyMessages[splitIndex]?.role === 'tool') {
    assistantIndex = findOwningAssistantIndex(historyMessages, splitIndex);
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
 *
 * ONE UNIT SYSTEM: every count here is a CALIBRATED count (the tokenizer's
 * own count is never compared against a token budget), and the class is
 * `chat` — the slice and the preserved window are parts of the MAIN chat
 * request, so they are measured the way a chat request is shaped. The
 * summariser's budget, which is measured in the `summarise` class, is a
 * different request and is sized in `reduce.ts`.
 */
export function splitHistoryForCompaction(
  historyMessages: ChatMessage[],
  model: string,
  numCtx: number,
  aggressiveFactor: number = 1
): HistorySplit {
  if (historyMessages.length <= 1) {
    return makeHistorySplit(historyMessages, [], model);
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
    return makeHistorySplit(
      historyMessages.slice(0, windowSplitIndex),
      windowPreservedMessages,
      model
    );
  }

  // The user prompt sits in the "to-summarise" portion — it must be rescued.
  const anchorMessage = historyMessages[latestUserIndex]!;
  const prePromptMessages = historyMessages.slice(0, latestUserIndex);
  const postPromptPreWindowMessages = historyMessages.slice(latestUserIndex + 1, windowSplitIndex);

  // Try A: summarise only the pre-prompt history (cleanest split).
  if (countMessagesTokens(prePromptMessages, model) >= MIN_SUMMARISE_TOKENS) {
    // Preserve the assistant/tool turns that sit between the anchor user
    // prompt and the sliding-window boundary too. They are the anchor
    // prompt's actual response and must not be silently dropped — the old
    // code excluded `postPromptPreWindowMessages` from BOTH
    // `messagesToSummarise` and `preservedRecentMessages`, so compaction
    // permanently lost that conversation content.
    return makeHistorySplit(
      prePromptMessages,
      [anchorMessage, ...postPromptPreWindowMessages, ...windowPreservedMessages],
      model
    );
  }

  // Try B: pre-prompt content alone is too small. Also fold in the post-prompt
  // assistant/tool messages that sit between the anchor and the sliding-window
  // boundary. The user prompt itself is still held out verbatim.
  const combinedToSummarise = [...prePromptMessages, ...postPromptPreWindowMessages];
  if (countMessagesTokens(combinedToSummarise, model) >= MIN_SUMMARISE_TOKENS) {
    return makeHistorySplit(
      combinedToSummarise,
      [anchorMessage, ...windowPreservedMessages],
      model
    );
  }

  // Fallback: still not enough. Return the pre-prompt slice; the caller's
  // MIN_SUMMARISE_TOKENS guard will decide whether to abort or expand.
  // As in Try A, the post-prompt assistant/tool turns are preserved (not
  // dropped) so the anchor prompt's response survives compaction intact.
  return makeHistorySplit(
    prePromptMessages,
    [anchorMessage, ...postPromptPreWindowMessages, ...windowPreservedMessages],
    model
  );
  // ── End anchor adjustment ─────────────────────────────────────────────
}

/**
 * The split the compaction actually runs on: {@link splitHistoryForCompaction},
 * then — when it leaves too little to summarise — the fallback ladder.
 *
 * The ladder only runs when the slice to summarise is under
 * `MIN_SUMMARISE_TOKENS` AND something is preserved:
 *
 * - the latest real user prompt (the anchor) is NOT the first message: cut at
 *   the anchor, so everything before it is summarised and the anchor and what
 *   followed stay verbatim;
 * - there is no real user prompt at all: summarise everything, preserve
 *   nothing (a last resort);
 * - the anchor IS the first message: there is no older history to widen into,
 *   so the split is kept as it is, unless it left NOTHING to summarise, in
 *   which case everything is summarised.
 *
 * Returns the split together with the tokens of the slice to summarise AFTER
 * the ladder (counted once), so the caller can refuse a history that is still
 * too short without counting it again.
 */
export function planCompactionSplit(
  historyMessages: ChatMessage[],
  model: string,
  numCtx: number,
  aggressiveFactor: number = 1
): { split: HistorySplit; summariseTokens: number } {
  const split = splitHistoryForCompaction(historyMessages, model, numCtx, aggressiveFactor);
  const summariseTokens = countMessagesTokens(split.messagesToSummarise, model);
  if (summariseTokens >= MIN_SUMMARISE_TOKENS || split.preservedRecentMessages.length === 0) {
    return { split, summariseTokens };
  }

  const anchorIndex = findLatestUserMessageIndex(historyMessages);
  let widened: HistorySplit | undefined;
  if (anchorIndex > 0) {
    widened = makeHistorySplit(
      historyMessages.slice(0, anchorIndex),
      historyMessages.slice(anchorIndex),
      model
    );
  } else if (anchorIndex < 0 || split.messagesToSummarise.length === 0) {
    widened = makeHistorySplit(historyMessages, [], model);
  }
  if (widened === undefined) {
    return { split, summariseTokens };
  }
  return {
    split: widened,
    summariseTokens: countMessagesTokens(widened.messagesToSummarise, model),
  };
}

/** A split with its preserved-window token count filled in (0 for an empty window). */
function makeHistorySplit(
  messagesToSummarise: ChatMessage[],
  preservedRecentMessages: ChatMessage[],
  model: string
): HistorySplit {
  return {
    messagesToSummarise,
    preservedRecentMessages,
    preservedRecentTokens: countMessagesTokens(preservedRecentMessages, model),
  };
}

/**
 * Splits an oversized message array into contiguous chunks that each fit within
 * `safeInputBudget` tokens. A chunk never begins on a `tool` message: if the
 * next message would overflow but is a tool response, it is folded into the
 * current chunk so assistant + tool-response blocks always stay together (even
 * if that slightly exceeds the nominal budget).
 *
 * ONE UNIT SYSTEM: the budget is a number of provider tokens, so the
 * estimator has to be a calibrated count — a raw count is 25–40 % smaller
 * than the provider's own count of the same text, and a chunk fitted against
 * a raw estimate is sent over the window. The class is `summarise`, because
 * a chunk is a piece of the SUMMARISER's request: the map-reduce path
 * overrides the estimator with the size of the SERIALISED message (that is
 * what the summariser actually receives), and the default measures the same
 * request shape.
 *
 * @param estimateMessageTokens - How many tokens a single message contributes.
 *                               Defaults to the calibrated message estimate.
 *                               The map-reduce path overrides it with the size
 *                               of the SERIALISED message, because that is
 *                               what the summariser actually receives.
 */
export function splitHistoryIntoChunks(
  messages: ChatMessage[],
  safeInputBudget: number,
  model: string,
  estimateMessageTokens: (message: ChatMessage) => number = (message) =>
    countMessageTokens(message, model, 'summarise')
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
    const messageTokens = estimateMessageTokens(message);
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
