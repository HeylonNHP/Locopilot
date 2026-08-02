/**
 * orchestrate.ts
 *
 * Top-level compaction flow. Wires history splitting, tool distillation,
 * summary generation (single-shot or map-reduce) and result validation into the
 * public `compactHistory` entry point used by the web route, the chat route and
 * the sub-agent auto-compactor.
 */

import type { ChatMessage, LlmRequestContext } from '@/services/llm';

import { countMessagesTokens } from '@/services/tokenizer';

import type { CompactResult, CompactStats } from './types';

import { COMPACT_ACCEPTANCE_HEADROOM, MIN_SUMMARISE_TOKENS, SUMMARY_PREAMBLE } from './constants';
import { distillToolMessages } from './distill';
import { measureConversationTokens } from './measure';
import { produceConversationSummary } from './reduce';
import { findLatestUserMessageIndex, splitHistoryForCompaction } from './split';

/**
 * Compacts the provided conversation history by asking the LLM to summarise it.
 * Returns the new message array and stats comparing old vs new sizes.
 *
 * Large older histories are processed with a bounded map-reduce pipeline so no
 * single summarisation request can exceed the model's context window.
 *
 * @param ctx             - Per-request LLM context (provider, baseUrl, apiKey).
 *                          Threaded through every nested call so concurrent
 *                          compaction requests cannot clobber each other.
 * @param model           - Model name to use for summarisation.
 * @param messages        - Current conversation history (should include system prompt).
 * @param numCtx          - Context length to pass to the API.
 * @param onProgress      - Optional callback for live progress updates.
 * @param aggressiveFactor - >1 to force stronger compression.
 * @param remainingRetries - How many aggressive retry passes remain.
 * @param onStats         - Optional callback for token stats.
 * @param signal          - Optional AbortSignal.
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

  // Filter out system messages — the system prompt is injected on-the-fly by
  // the caller and should not be preserved through compaction.
  const historyMessages = messages.filter((m) => m.role !== 'system');
  if (historyMessages.length === 0) {
    throw new Error('Cannot compact: conversation has no content beyond the system prompt.');
  }

  // ── Guard against degenerate empty-summary crash ─────────────────────────
  // Subagents (and any short-history code path) can reach this point with
  // messages === [system] — i.e. zero history beyond the system prompt.
  // splitHistoryForCompaction would then return an empty messagesToSummarise,
  // and the downstream estimate collapses to a tiny value. Callers already
  // refuse to compact when fewer than 4 messages exist; this guard is the
  // final safety net against a confusing near-zero-token estimate.

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
      // No user anchor found — fall back to summarising the full history as a
      // last resort.
      historySplit = {
        messagesToSummarise: historyMessages,
        preservedRecentMessages: [],
        preservedRecentTokens: 0,
      };
    } else {
      // anchorIndex === 0: the first history message is the latest user prompt.
      // There is no pre-anchor history, but if the split left nothing to
      // summarise, fall back to summarising the whole history so we don't abort
      // with a confusing near-zero token estimate.
      if (historySplit.messagesToSummarise.length === 0) {
        historySplit = {
          messagesToSummarise: historyMessages,
          preservedRecentMessages: [],
          preservedRecentTokens: 0,
        };
      }
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

  // Distill large tool outputs in the older slice before summarising.
  const preparedHistoryMessages = await distillToolMessages(
    ctx,
    historySplit.messagesToSummarise,
    numCtx,
    model,
    onProgress,
    signal
  );

  // Also distill large tool outputs in the preserved window so they don't land
  // in newMessages at full size, which is the main cause of compaction failing
  // to bring token counts under the model context limit.
  const preparedRecentMessages = await distillToolMessages(
    ctx,
    historySplit.preservedRecentMessages,
    numCtx,
    model,
    onProgress,
    signal
  );

  // Generate the summary: single-shot when it fits, bounded map-reduce when the
  // older history exceeds the safe input budget.
  const summary = await produceConversationSummary(
    ctx,
    model,
    numCtx,
    aggressiveFactor,
    preparedHistoryMessages,
    onProgress,
    signal
  );

  // Rebuild the message history: a single assistant message holds the preamble
  // + summary, followed by the distilled recent messages.
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
