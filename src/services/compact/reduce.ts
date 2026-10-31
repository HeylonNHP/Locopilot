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
import { countMessagesTokens, countTextTokens } from '@/services/tokenizer';

import type { ToolNameMap } from './types';

import { computeSafeInputBudget, computeSummaryBudget } from './budget';
import { REDUCTION_COMBINE_SYSTEM_PROMPT, REDUCTION_FAN_IN } from './constants';
import { serializeHistoryForSummaryText, type SerializeHistoryOptions } from './serialize';
import { splitHistoryIntoChunks } from './split';
import { summariseChunk, summariseMessages } from './summarize';

/** The blank line that separates two serialised history blocks. */
const SERIALIZED_BLOCK_SEPARATOR = '\n\n';

/**
 * The smallest cap a tool result may get, in characters.
 *
 * The cap is derived from the safe input budget (which is in TOKENS): a tool
 * result is roughly four characters per token, so the budget-derived number
 * of characters is generous at a small context window and roomy at a large
 * one — and it never falls below the floor that keeps a tool result legible.
 */
const MIN_TOOL_RESULT_CHARS = 2000;

/**
 * Estimates how many tokens one message contributes to the SERIALISED history
 * the summariser actually receives.
 *
 * The raw message estimate is not a safe proxy: the serialisation adds the
 * tool labels and the projected arguments, so a chunk measured on the raw
 * messages can overflow the safe input budget once it is rendered. The block
 * separator is included so that summing the per-message estimates also covers
 * the separators between the blocks.
 *
 * The options MUST be the ones the summarisation itself uses (the tool-name
 * map, the redaction switch and the tool-result cap), or the estimate
 * measures a different text than the one that is sent.
 *
 * Exported so the chunk sizing can be tested without a model call.
 */
export function estimateSerializedMessageTokens(
  message: ChatMessage,
  options: SerializeHistoryOptions | undefined,
  model: string
): number {
  const text = serializeHistoryForSummaryText([message], options);
  if (text.length === 0) {
    return 0;
  }
  return countTextTokens(`${text}${SERIALIZED_BLOCK_SEPARATOR}`, model);
}

/**
 * Produces the final conversation summary from an older-history slice.
 *
 * If the slice fits within the safe input budget, a single summarisation
 * request is used (the common case). Otherwise the slice is split into bounded
 * chunks which are summarised independently and then reduced hierarchically.
 *
 * @param toolNames - Tool-call id → tool name, built from the FULL
 *                    conversation. A tool result can outlive the assistant row
 *                    that issued it, so the map must not be derived from the
 *                    slice alone.
 * @param redactSecrets - Whether secrets are redacted out of the projected
 *                        arguments AND the tool results. Defaults to true.
 */
export async function produceConversationSummary(
  ctx: LlmRequestContext,
  model: string,
  numCtx: number,
  aggressiveFactor: number,
  preparedHistoryMessages: ChatMessage[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  onTps?: (tps: number) => void,
  toolNames?: ToolNameMap | undefined,
  redactSecrets?: boolean | undefined
): Promise<string> {
  const safeInputBudget = computeSafeInputBudget(numCtx);

  // The tool result is the only unbounded part of the serialised input, so it
  // is capped to a budget-derived number of CHARACTERS (the safe budget is in
  // tokens, and a tool result is roughly four characters per token).
  const maxToolResultChars = Math.max(MIN_TOOL_RESULT_CHARS, safeInputBudget);

  // The ONE set of serialisation options. The fit test, the chunk boundaries
  // and the summarisation request itself all have to measure the SAME text.
  const serializeOptions: SerializeHistoryOptions = {
    ...(toolNames ? { toolNames } : {}),
    redactSecrets: redactSecrets ?? true,
    maxToolResultChars,
  };

  // The summariser receives the SERIALISED history, so the fit test and the
  // chunk boundaries have to be measured against the serialised size — the
  // raw message estimate does not include the tool labels and the projected
  // arguments, and it does include the file bodies the serialiser drops.
  //
  // The SUMMARY budget is computed from the same serialised estimate: the
  // raw estimate counts whole `tool_calls` argument bodies (a `write_file`
  // body is megabytes of source code the summariser never sees), so sizing
  // the summary against it asks for a summary of something the model was
  // never given.
  const serializedEstimate = countTextTokens(
    serializeHistoryForSummaryText(preparedHistoryMessages, serializeOptions),
    model
  );

  if (serializedEstimate <= safeInputBudget) {
    const budget = computeSummaryBudget(numCtx, aggressiveFactor, serializedEstimate);
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
      ...(onTps ? { onTps } : {}),
      ...(toolNames ? { toolNames } : {}),
      redactSecrets: redactSecrets ?? true,
      maxToolResultChars,
    });
  }

  const chunks = splitHistoryIntoChunks(
    preparedHistoryMessages,
    safeInputBudget,
    model,
    (message) => estimateSerializedMessageTokens(message, serializeOptions, model)
  );
  onProgress?.(
    `History is too large for a single pass (${serializedEstimate} tokens) — ` +
      `splitting into ${chunks.length} chunks for map-reduce compaction.`
  );

  const chunkSummaries: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) {
      continue;
    }
    // The chunk's budget is sized against the SERIALISED chunk — the same
    // number the chunk boundary was drawn with.
    const chunkSerializedEstimate = countTextTokens(
      serializeHistoryForSummaryText(chunk, serializeOptions),
      model
    );
    const chunkBudget = computeSummaryBudget(numCtx, aggressiveFactor, chunkSerializedEstimate);
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
      ...(onTps ? { onTps } : {}),
      ...(toolNames ? { toolNames } : {}),
      redactSecrets: redactSecrets ?? true,
      maxToolResultChars,
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
    reasoningEffort,
    onTps
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
  reasoningEffort?: ReasoningEffort,
  onTps?: (tps: number) => void
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
      reasoningEffort,
      onTps
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
    reasoningEffort,
    onTps
  );
}
