/**
 * reduce.ts
 *
 * Map-reduce orchestration for large histories. When the older-history slice is
 * too large to summarise in a single request, it is split into bounded chunks,
 * each chunk is summarised independently, and the chunk summaries are then
 * combined in bounded batches until one coherent summary remains.
 *
 * Every individual LLM request here is bounded by `computeSafeInputBudget`, so
 * no stage ever needs the whole conversation to fit into one context window.
 */

import type { ReasoningEffort } from '@/types/chatConfig';

import { type ChatMessage, type LlmRequestContext } from '@/services/llm';
import { countMessagesTokens } from '@/services/tokenizer';

import { computeSafeInputBudget, computeSummaryBudget } from './budget';
import { REDUCTION_COMBINE_SYSTEM_PROMPT, REDUCTION_FAN_IN } from './constants';
import { splitHistoryIntoChunks } from './split';
import { summariseChunk, summariseMessages } from './summarize';

/**
 * Produces the final conversation summary from an older-history slice.
 *
 * If the slice fits within the safe input budget, a single summarisation
 * request is used (the common case). Otherwise the slice is split into bounded
 * chunks which are summarised independently and then reduced hierarchically.
 */
export async function produceConversationSummary(
  ctx: LlmRequestContext,
  model: string,
  numCtx: number,
  aggressiveFactor: number,
  preparedHistoryMessages: ChatMessage[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort
): Promise<string> {
  const sourceEstimate = countMessagesTokens(preparedHistoryMessages, model);
  const safeInputBudget = computeSafeInputBudget(numCtx);

  if (sourceEstimate <= safeInputBudget) {
    const budget = computeSummaryBudget(numCtx, aggressiveFactor, sourceEstimate);
    return summariseChunk({
      ctx,
      model,
      numCtx,
      historyMessages: preparedHistoryMessages,
      budget,
      preservedRecentTokens: 0,
      ...(onProgress ? { onProgress } : {}),
      ...(signal ? { signal } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
  }

  const chunks = splitHistoryIntoChunks(preparedHistoryMessages, safeInputBudget, model);
  onProgress?.(
    `History is too large for a single pass (${sourceEstimate} tokens) — ` +
      `splitting into ${chunks.length} chunks for map-reduce compaction.`
  );

  const chunkSummaries: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) {
      continue;
    }
    const chunkBudget = computeSummaryBudget(
      numCtx,
      aggressiveFactor,
      countMessagesTokens(chunk, model)
    );
    const label = `chunk ${index + 1}/${chunks.length}`;
    const summary = await summariseChunk({
      ctx,
      model,
      numCtx,
      historyMessages: chunk,
      budget: chunkBudget,
      preservedRecentTokens: 0,
      label,
      ...(onProgress ? { onProgress } : {}),
      ...(signal ? { signal } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
    chunkSummaries.push(summary);
  }

  onProgress?.('Reducing chunk summaries...');
  return reduceSummaryGroups(
    ctx,
    model,
    numCtx,
    aggressiveFactor,
    chunkSummaries,
    onProgress,
    signal,
    reasoningEffort
  );
}

/**
 * Combines partial summaries in bounded batches until a single summary remains.
 * Terminates when one summary is left; otherwise fans out into batches of
 * `REDUCTION_FAN_IN` and recurses on the resulting batch summaries.
 */
export async function reduceSummaryGroups(
  ctx: LlmRequestContext,
  model: string,
  numCtx: number,
  aggressiveFactor: number,
  summaries: string[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort
): Promise<string> {
  if (summaries.length === 1) {
    return summaries[0]!;
  }

  const batches: string[][] = [];
  for (let start = 0; start < summaries.length; start += REDUCTION_FAN_IN) {
    batches.push(summaries.slice(start, start + REDUCTION_FAN_IN));
  }

  const batchSummaries: string[] = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    if (!batch) {
      continue;
    }
    const offset = batchIndex * REDUCTION_FAN_IN;
    const label =
      batches.length > 1 ? `reduction group ${batchIndex + 1}/${batches.length}` : undefined;

    const batchText = batch
      .map((section, index) => `[PART ${offset + index + 1}]:\n${section}`)
      .join('\n\n');
    const batchMessages: ChatMessage[] = [
      {
        role: 'system',
        content: REDUCTION_COMBINE_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: `Combine the following partial summaries into one coherent summary:\n\n${batchText}`,
      },
    ];

    const sourceEstimate = countMessagesTokens(batchMessages, model);
    const budget = computeSummaryBudget(numCtx, aggressiveFactor, sourceEstimate);
    onProgress?.(label ? `Reducing ${label}...` : 'Reducing summaries...');

    const combined = await summariseMessages(
      ctx,
      model,
      numCtx,
      batchMessages,
      batchText,
      budget,
      onProgress,
      signal,
      reasoningEffort
    );
    batchSummaries.push(combined);
  }

  return reduceSummaryGroups(
    ctx,
    model,
    numCtx,
    aggressiveFactor,
    batchSummaries,
    onProgress,
    signal,
    reasoningEffort
  );
}
