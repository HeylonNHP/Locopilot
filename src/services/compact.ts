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
 *
 * This compaction will preserve the most recent user prompt verbatim, summarise
 * older history, and retry once with a stronger compression factor if the
 * first pass still leaves the history too large for the model.
 */

import {
  type ChatMessage,
  getLlmTurnStats,
  type LlmRequestContext,
  sendLlmChat,
  sendLlmChatStream,
} from './llm';
import { countMessagesTokens, countMessageTokens } from './tokenizer';

// The instruction sent to the LLM when asking it to compact the history.
function buildCompactSystemPrompt(params: {
  targetSummaryTokens: number;
  minSummaryTokens: number;
  maxSummaryTokens: number;
  preservedRecentTokens: number;
  numCtx: number;
}): string {
  return (
    'You are a conversation summariser. You will be given OLDER conversation history from a ' +
    'chat session between a user and an AI assistant. NEWER recent turns are preserved verbatim ' +
    `outside this summary (${params.preservedRecentTokens} estimated tokens).\n` +
    'Produce one dense narrative summary that:\n' +
    '  1. Retains every decision, fact, file path, code snippet, command, result, and unresolved task ' +
    'that could affect future responses.\n' +
    '  2. Keeps chronology and causality clear (what happened, why, and what the latest status is).\n' +
    '  3. Strips only filler/repetition; do NOT over-compress technical details.\n' +
    '  4. Is written in third person (e.g. "The user asked... The assistant explained...").\n' +
    `  5. Targets approximately ${params.targetSummaryTokens} tokens (acceptable range: ${params.minSummaryTokens}-${params.maxSummaryTokens}) within a context window of ${params.numCtx} tokens.\n` +
    '  6. Never exceed the max token range unless required to avoid losing critical technical facts.\n' +
    'Prefer detail over brevity when details are technical and likely to matter later.\n' +
    'Return ONLY plain summary text (no headings, no markdown, no commentary).'
  );
}

// The instruction used to distill large tool outputs before running full
// conversation compaction.
const TOOL_DISTILL_SYSTEM_PROMPT =
  'You are a tool-output distiller. You will be given one tool result from an AI chat. ' +
  'Produce a compact, loss-minimised digest that preserves durable technical value.\n' +
  'Keep: concrete facts, file paths, URLs, commands, exit codes, errors, versions, and final outcomes.\n' +
  'Drop: boilerplate formatting, duplicated lines, verbose prose, and filler.\n' +
  'If this output is already concise, return a near-verbatim version.\n' +
  'Write plain text only (no markdown).';

const TOOL_DISTILL_CHAR_THRESHOLD = 1200;
const TOOL_DISTILL_MAX_CHARS = 2400;
const TOOL_DISTILL_NUM_PREDICT = 1024;
const MIN_SUMMARISE_TOKENS = 200;
const PRESERVE_RECENT_TOKENS_RATIO = 0.12;
const SUMMARY_TARGET_TOKENS_RATIO = 0.1;
const SUMMARY_MAX_TOKENS_RATIO = 0.18;
const SUMMARY_NUM_PREDICT_BUFFER_RATIO = 1.2;

// Compacted result must fit within this fraction of numCtx to be accepted
// without triggering an automatic aggressive retry pass.
const COMPACT_ACCEPTANCE_HEADROOM = 0.9;

// Preamble injected at the start of the compacted history so the model knows
// it is reading a summary rather than a live transcript.
const SUMMARY_PREAMBLE =
  '[This conversation history has been compacted. What follows is a concise ' +
  'summary of everything important that has occurred so far. Treat it as ' +
  'authoritative context for continuing the conversation.]';

export interface CompactStats {
  oldTokenCount: number;
  newTokenCount: number;
}

export interface CompactResult {
  /** The new, compacted message array that should replace the live history. */
  newMessages: ChatMessage[];
  /** Token counts for display purposes. */
  stats: CompactStats;
}

interface HistorySplit {
  messagesToSummarise: ChatMessage[];
  preservedRecentMessages: ChatMessage[];
  preservedRecentTokens: number;
}

async function measureConversationTokens(
  ctx: LlmRequestContext,
  messages: ChatMessage[],
  model: string,
  numCtx: number,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<number> {
  onProgress?.('Measuring conversation tokens...');

  try {
    // Use a significantly larger context window for the measurement call
    // to avoid Status 400 errors when the history is already at 100% capacity.
    const measurementCtx = Math.max(numCtx * 2, 32768);

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
    // If the API call fails (e.g. backend is very strict), fall back to
    // the local tiktoken estimate instead of crashing.
    onProgress?.('API measurement failed; falling back to local estimate...');
  }

  return countMessagesTokens(messages, model);
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function computeRecentMessageFloor(numCtx: number): number {
  return clamp(Math.round(numCtx / 32768) + 2, 2, 8);
}

/** Returns the index of the most recent `role === 'user'` message, or -1 if none. */
function findLatestUserMessageIndex(messages: ChatMessage[]): number {
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
  if (
    assistantIndex < 0 &&
    historyMessages[splitIndex - 1]?.role === 'assistant'
  ) {
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
    assistant.tool_calls
      ?.map((tc) => tc.id)
      .filter((id): id is string => typeof id === 'string')
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

function splitHistoryForCompaction(
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
    Math.max(300, Math.floor((numCtx * 0.03) / aggressiveFactor)),
    Math.floor((numCtx * 0.3) / aggressiveFactor)
  );
  const minMessagesToSummarise = Math.min(
    Math.max(1, Math.ceil(historyMessages.length * 0.25)),
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

function getToolMessageName(message: ChatMessage): string {
  const firstToolCall = message.tool_calls?.[0];
  const name = firstToolCall?.function?.name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'unknown_tool';
}

/**
 * Returns the index of the assistant message that owns the tool message at
 * `toolIndex`, or -1 if no matching assistant is found in the same contiguous
 * tool block.
 */
function findMatchingAssistantIndex(
  messages: ChatMessage[],
  toolIndex: number
): number {
  if (toolIndex <= 0) return -1;
  const toolCallId = messages[toolIndex]?.tool_call_id;
  if (!toolCallId) return -1;
  for (let i = toolIndex - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (
      candidate?.role === 'assistant' &&
      candidate?.tool_calls?.some((tc) => tc.id === toolCallId)
    ) {
      return i;
    }
    if (candidate?.role !== 'tool') {
      break;
    }
  }
  return -1;
}

async function distillToolMessages(
  ctx: LlmRequestContext,
  historyMessages: ChatMessage[],
  numCtx: number,
  model: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<ChatMessage[]> {
  const distilledMessages: ChatMessage[] = [];

  for (let index = 0; index < historyMessages.length; index += 1) {
    const message = historyMessages[index];
    if (!message) {
      continue;
    }

    const shouldDistill =
      message.role === 'tool' && (message.content?.length ?? 0) >= TOOL_DISTILL_CHAR_THRESHOLD;

    if (!shouldDistill) {
      distilledMessages.push(message);
      continue;
    }

    const matchingAssistantIndex = findMatchingAssistantIndex(historyMessages, index);
    if (matchingAssistantIndex < 0) {
      // The matching assistant is not in this message slice (possible if the
      // history was split across an assistant/tool block). Preserve the tool
      // result verbatim to avoid orphan-conversion issues.
      distilledMessages.push(message);
      continue;
    }

    const previous = historyMessages[matchingAssistantIndex];
    const toolName = previous ? getToolMessageName(previous) : 'unknown_tool';

    // Guard against sending massive tool outputs to the distillation LLM.
    // A single tool output can exceed numCtx, causing the distillation call
    // itself to fail with a 400.
    const DISTILL_INPUT_MAX_CHARS = Math.min(50_000, numCtx * 8);
    const distillInputContent =
      message.content.length > DISTILL_INPUT_MAX_CHARS
        ? `${message.content.slice(0, DISTILL_INPUT_MAX_CHARS) 
          }\n\n[...truncated ${message.content.length - DISTILL_INPUT_MAX_CHARS} chars for distillation]`
        : message.content;

    const input =
      `Tool name: ${toolName}\n` +
      `Tool output length: ${message.content.length} chars${message.content.length > DISTILL_INPUT_MAX_CHARS ? ' (truncated for distillation)' : ''}\n\n` +
      `Tool output:\n${ 
      distillInputContent}`;

    let distilledContent = '';
    const distillResponse = await sendLlmChat(
      ctx,
      {
        model,
        messages: [
          { role: 'system', content: TOOL_DISTILL_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        tools: [],
        numCtx,
        maxOutputTokens: TOOL_DISTILL_NUM_PREDICT,
        options: {
          temperature: 0,
        },
      },
      (chunk) => {
        if (chunk.message?.content) {
          distilledContent += chunk.message.content;
          onProgress?.(
            `Distilling tool output ${index + 1}/${historyMessages.length} (${toolName})... (${distilledContent.length} chars)`
          );
        }
      },
      undefined,
      signal
    );

    const rawDigest = (distillResponse.message?.content ?? '').trim();
    const digest =
      rawDigest.length > 0
        ? rawDigest.slice(0, TOOL_DISTILL_MAX_CHARS)
        : message.content.slice(0, TOOL_DISTILL_MAX_CHARS);

    distilledMessages.push({
      ...message,
      content:
        `[Distilled tool output from ${toolName}; original length ${message.content.length} chars]\n${ 
        digest}`,
    });

    onProgress?.(
      `Distilled tool output ${distilledMessages.length}/${historyMessages.length} (${toolName})`
    );
  }

  return distilledMessages;
}

/**
 * Compacts the provided conversation history by asking the LLM to summarise
 * it. Returns the new message array and stats comparing old vs new sizes.
 *
 * @param ctx        - Per-request LLM context (provider, baseUrl, apiKey).
 *                     Threaded through every nested call so concurrent
 *                     compaction requests cannot clobber each other.
 * @param model      - Model name to use for summarisation
 * @param messages   - Current conversation history (should include system prompt)
 * @param numCtx     - Context length to pass to the API
 * @param onProgress - Optional callback for live progress updates
 */
export async function compactHistory(
  ctx: LlmRequestContext,
  model: string,
  messages: ChatMessage[],
  numCtx: number,
  onProgress?: (message: string) => void,
  aggressiveFactor: number = 1,
  remainingRetries: number = 2,
  onStats?: (stats: CompactStats) => void,
  signal?: AbortSignal
): Promise<CompactResult> {
  const oldTokenCount = await measureConversationTokens(
    ctx,
    messages,
    model,
    numCtx,
    onProgress,
    signal
  );

  // Filter out system messages — the system prompt is injected on-the-fly
  // by the caller and should not be preserved through compaction.
  const historyMessages = messages.filter((m) => m.role !== 'system');
  if (historyMessages.length === 0) {
    throw new Error('Cannot compact: conversation has no content beyond the system prompt.');
  }
  // ── Guard against degenerate empty-summary crash ─────────────────────────
  // Subagents (and any short-history code path) can reach this point with
  // messages === [system] — i.e. zero history beyond the system prompt.
  // splitHistoryForCompaction would then return an empty messagesToSummarise,
  // and the downstream estimate collapses to a tiny value. That produces the
  // cryptic error:
  //   "The conversation history is too short to compact (~0 tokens)."
  // which is impossible to debug because a near-empty history is nowhere near the
  // MIN_SUMMARISE_TOKENS threshold of 200.
  //
  // The deeper root: when the latest user message is the FIRST history entry
  // (index 0), the anchor-rescue logic in splitHistoryForCompaction tries to
  // preserve it verbatim.  If the preservation loop consumed everything after
  // it, there is nothing left to summarise — prePromptMessages is empty and
  // postPromptPreWindowMessages is also empty — so the fallback returns an
  // empty messagesToSummarise array.
  //
  // The fix has two layers:
  // 1. Callers (autoCompactSubAgentIfNeeded, the web chat route) now refuse
  //    to compact when fewer than 4 messages exist (system + at least one
  //    user/assistant/tool exchange), which is the practical guard.
  // 2. Below, if historyMessages is empty despite that guard, we fail fast
  //    with a meaningful error instead of letting the empty-array propagate.
  //
  // For the edge case where anchorIndex === 0 and the split IS empty, the
  // expansion block further down falls back to summarising the whole
  // historyMessages array rather than silently doing nothing and crashing.

  let historySplit = splitHistoryForCompaction(historyMessages, model, numCtx, aggressiveFactor);

  // If the split leaves too little content to summarize, expand the summarised
  // section only when there is pre-anchor history to include. Otherwise keep
  // the anchored split and let the too-short guard abort compaction.
  const splitEstimate = countMessagesTokens(historySplit.messagesToSummarise, model);
  if (splitEstimate < MIN_SUMMARISE_TOKENS && historySplit.preservedRecentMessages.length > 0) {
    const anchorIndex = findLatestUserMessageIndex(historyMessages);
    if (anchorIndex > 0) {
      historySplit = {
        messagesToSummarise: historyMessages.slice(0, anchorIndex),
        preservedRecentMessages: historyMessages.slice(anchorIndex),
        preservedRecentTokens: countMessagesTokens(historyMessages.slice(anchorIndex), model),
      };
    } else if (anchorIndex < 0) {
      // No user anchor found — fall back to summarising the full history as
      // a last resort.
      historySplit = {
        messagesToSummarise: historyMessages,
        preservedRecentMessages: [],
        preservedRecentTokens: 0,
      };
    } else {
      // anchorIndex === 0: the first history message is the latest user prompt.
      // There is no pre-anchor history, but if the split left nothing to
      // summarise (which can happen when the preservation loop consumed
      // everything), fall back to summarising the whole history so we don't
      // abort with a confusing near-zero token estimate.
      if (historySplit.messagesToSummarise.length === 0) {
        historySplit = {
          messagesToSummarise: historyMessages,
          preservedRecentMessages: [],
          preservedRecentTokens: 0,
        };
      }
      // Otherwise keep the anchored split intact and let the too-short guard
      // decide whether to abort.
    }
  }

  const fullEstimate = countMessagesTokens(historySplit.messagesToSummarise, model);
  if (fullEstimate < MIN_SUMMARISE_TOKENS) {
    throw new Error(
      `The conversation history is too short to compact (~${fullEstimate} tokens). ` +
        'Continue the conversation and try /compact again when there is more context.'
    );
  }

  onProgress?.(
    `Preparing compaction: summarizing ${historySplit.messagesToSummarise.length} messages, preserving ${historySplit.preservedRecentMessages.length} recent messages`
  );

  const preparedHistoryMessages = await distillToolMessages(
    ctx,
    historySplit.messagesToSummarise,
    numCtx,
    model,
    onProgress,
    signal
  );

  // Also distill large tool outputs in the preserved window so they don't
  // land in newMessages at full size, which is the main cause of compaction
  // failing to bring token counts under the model context limit.
  const preparedRecentMessages = await distillToolMessages(
    ctx,
    historySplit.preservedRecentMessages,
    numCtx,
    model,
    onProgress,
    signal
  );

  const summarisedSourceTokenEstimate = Math.max(
    1,
    countMessagesTokens(preparedHistoryMessages, model)
  );

  const rawMaxSummaryTokens = clamp(
    Math.floor((numCtx * SUMMARY_MAX_TOKENS_RATIO) / aggressiveFactor),
    Math.max(600, Math.floor((numCtx * 0.05) / aggressiveFactor)),
    Math.max(1200, Math.floor((numCtx * 0.3) / aggressiveFactor))
  );
  // Cap the summary budget so it can never exceed the source it is compressing.
  // Without this a tiny conversation gets a confusingly large target, which
  // can cause some models to output nothing.
  const sourceCappedMaxSummaryTokens = Math.max(
    50,
    Math.floor(summarisedSourceTokenEstimate * 0.7)
  );
  const maxSummaryTokens = Math.min(rawMaxSummaryTokens, sourceCappedMaxSummaryTokens);
  const rawTargetSummaryTokens = clamp(
    Math.floor((numCtx * SUMMARY_TARGET_TOKENS_RATIO) / aggressiveFactor),
    Math.max(500, Math.floor((numCtx * 0.04) / aggressiveFactor)),
    rawMaxSummaryTokens
  );
  const targetSummaryTokens = clamp(
    Math.min(rawTargetSummaryTokens, maxSummaryTokens),
    50,
    maxSummaryTokens
  );
  const minSummaryTokens = Math.max(50, Math.floor(targetSummaryTokens * 0.65));
  const summaryNumPredict = Math.min(
    numCtx,
    Math.max(Math.floor(targetSummaryTokens * SUMMARY_NUM_PREDICT_BUFFER_RATIO), minSummaryTokens)
  );

  // Build a single user turn that presents the history to the summariser.
  const historyText = preparedHistoryMessages
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content ?? ''}`)
    .join('\n\n');

  const summarisationMessages: ChatMessage[] = [
    {
      role: 'system',
      content: buildCompactSystemPrompt({
        targetSummaryTokens,
        minSummaryTokens,
        maxSummaryTokens,
        preservedRecentTokens: historySplit.preservedRecentTokens,
        numCtx,
      }),
    },
    {
      role: 'user',
      content: `Please summarise the following conversation history:\n\n${  historyText}`,
    },
  ];

    const streamSummary = async (msgs: ChatMessage[], numPredict?: number): Promise<string> => {
      let text = '';
      for await (const chunk of sendLlmChatStream(ctx, {
        model,
        messages: msgs,
        tools: [],
        numCtx,
        ...(numPredict === undefined ? {} : { maxOutputTokens: numPredict }),
        options: {
          temperature: 0,
        },
        ...(signal ? { signal } : {}),
      })) {
      const content = chunk.message?.content ?? '';
      if (content.length > 0) {
        text += content;
        onProgress?.(`AI is summarizing... (${text.length} chars)`);
      }
    }
    return text.trim();
  };

  let summary = await streamSummary(summarisationMessages, summaryNumPredict);

  // If the model returned nothing (can happen with very small inputs and a
  // large target), retry once with a dead-simple prompt and no token cap.
  if (!summary) {
    onProgress?.('Empty response — retrying with simplified prompt...');
    const retryMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a summariser. Produce a short plain-text summary of the conversation below. ' +
          'Keep all technical details. Return only the summary text.',
      },
      {
        role: 'user',
        content: `Summarise this conversation:\n\n${  historyText}`,
      },
    ];
    summary = await streamSummary(retryMessages);
  }

  if (!summary) {
    throw new Error(
      'The model returned an empty summary after two attempts. ' +
        'Try a different model or continue the conversation before compacting.'
    );
  }

  // Rebuild the message history: original system prompt + a single assistant
  // message that holds the preamble + summary.
  const newMessages: ChatMessage[] = [
    {
      role: 'assistant',
      content: `${SUMMARY_PREAMBLE}\n\n${summary}`,
    },
    ...preparedRecentMessages,
  ];

  const newTokenCount = await measureConversationTokens(
    ctx,
    newMessages,
    model,
    numCtx,
    onProgress,
    signal
  );

  if (newTokenCount >= oldTokenCount && oldTokenCount > 0) {
    throw new Error(
      `Compaction failed to reduce history size (old: ${oldTokenCount}, new: ${newTokenCount} tokens). ` +
        'Aborting to avoid increasing context usage.'
    );
  }

  // If the compacted result still exceeds the context window (with headroom),
  // retry with a stronger factor that shrinks preservation budgets and summary
  // targets, forcing more aggressive compression. Bounded by remainingRetries.
  const acceptanceBudget = Math.floor(numCtx * COMPACT_ACCEPTANCE_HEADROOM);
  if (newTokenCount > acceptanceBudget && remainingRetries > 0) {
    const retryFactor = Math.max(1.5, newTokenCount / (numCtx * 0.75));
    onProgress?.(
      `Compacted to ${newTokenCount} tokens but limit is ${numCtx} — ` +
        `retrying with ${retryFactor.toFixed(1)}x stronger compression (${remainingRetries} attempt(s) left)...`
    );
    const retryResult = await compactHistory(
      ctx,
      model,
      newMessages,
      numCtx,
      onProgress,
      retryFactor,
      remainingRetries - 1,
      onStats,
      signal
    );
    // Report stats relative to the original pre-compaction history.
    return {
      newMessages: retryResult.newMessages,
      stats: {
        oldTokenCount,
        newTokenCount: retryResult.stats.newTokenCount,
      },
    };
  }

  onStats?.({
    oldTokenCount,
    newTokenCount,
  });

  return {
    newMessages,
    stats: {
      oldTokenCount,
      newTokenCount,
    },
  };
}


