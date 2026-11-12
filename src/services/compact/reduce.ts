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
import { countCalibratedTextTokens, countMessagesTokens } from '@/services/tokenizer';

import type { CompactionLlmCall, ToolNameMap } from './types';

import {
  computeEffectiveInputBudget,
  computeSafeInputBudget,
  computeSummaryBudget,
} from './budget';
import {
  buildReductionCombineSystemPrompt,
  MAX_REDUCTION_ROUNDS,
  MIN_HISTORY_ALLOWANCE_TOKENS,
} from './constants';
import {
  batchReductionParts,
  buildReductionBatchText,
  concatenateReductionParts,
  REDUCTION_REQUEST_USER_PREFIX,
  type ReductionPart,
} from './reductionParts';
import { serializeHistoryForSummaryText, type SerializeHistoryOptions } from './serialize';
import { splitHistoryIntoChunks } from './split';
import {
  countPromptOverhead,
  countRetryPromptTokens,
  countSummarisationPromptTokens,
  summariseChunk,
  summariseMessages,
} from './summarize';
import {
  type BuildCompactSystemPromptParams,
  buildRetrySystemPrompt,
  type SummaryPromptMode,
} from './summaryPrompt';

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
 * ONE UNIT SYSTEM: the serialised text is measured with the CALIBRATED
 * counter, because the budget it is fitted into is a number of PROVIDER
 * tokens (the safe input budget is a share of the model's context window).
 * A raw count here is 25–40 % smaller than the provider's own count of the
 * same text, so a chunk fitted against a raw estimate is sent over the
 * window — which is how a summarisation request came to be rejected with an
 * empty summary. The class is `summarise`: the summariser's request is ONE
 * big blob, so it pays the provider's per-message framing once, not once per
 * message — and its factor is learned from summariser requests.
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
  return countCalibratedTextTokens(`${text}${SERIALIZED_BLOCK_SEPARATOR}`, model, 'summarise');
}

/**
 * The plan for one summarisation request: which prompt it carries and how
 * much room is left for the history.
 */
export interface SummarisationPromptPlan {
  /** Which system prompt the request carries. */
  mode: SummaryPromptMode;
  /** The tokens left for the history once the prompt is paid for. */
  historyBudget: number;
  /**
   * The tokens left for the history in the CHUNKED path.
   *
   * A chunked request carries an extra sentence (it says that the request
   * covers one slice of the older turns), so the chunker is given the
   * remainder of what is left after THAT prompt — otherwise a chunk that
   * fills the budget exactly would push the request over it.
   */
  chunkHistoryBudget: number;
  /** The token cost of the prompt that will be sent. */
  promptTokens: number;
}

/**
 * Chooses the prompt a summarisation request carries and the room left for
 * the history.
 *
 * WHY the short prompt exists: the full prompt costs ~800 tokens, and at a
 * small context window the safe input budget is smaller than that. The old
 * floor (`max(256, safe - prompt)`) DISCARDS the subtraction in that case,
 * so the prompt was charged nothing and the request could exceed the window
 * (at a 512-token context: 996 tokens sent against a 512-token window). The
 * floor now applies to the TOTAL, so the pipeline has to react to a small
 * window: it uses the short prompt — the same six-section contract without
 * the explanation of the input format — and if even that leaves no usable
 * room for the history, the compaction fails with a clear error.
 *
 * Returns `null` when neither prompt leaves at least
 * {@link MIN_HISTORY_ALLOWANCE_TOKENS} tokens for the history.
 */
export function planSummarisationPrompt(
  safeInputBudget: number,
  model: string,
  params: BuildCompactSystemPromptParams
): SummarisationPromptPlan | null {
  const fullPromptTokens = countSummarisationPromptTokens(params, model);
  const fullHistoryBudget = computeEffectiveInputBudget(safeInputBudget, fullPromptTokens);
  // The chunked prompt carries one extra sentence, so the chunker is sized
  // against what is left after THAT prompt.
  const chunkPromptTokens = countSummarisationPromptTokens(
    { ...params, chunkCount: 2, chunkIndex: 1 },
    model
  );
  const chunkHistoryBudget = computeEffectiveInputBudget(safeInputBudget, chunkPromptTokens);
  if (fullHistoryBudget >= MIN_HISTORY_ALLOWANCE_TOKENS) {
    return {
      mode: 'full',
      historyBudget: fullHistoryBudget,
      chunkHistoryBudget,
      promptTokens: fullPromptTokens,
    };
  }

  const shortPromptTokens = countRetryPromptTokens(
    {
      targetSummaryTokens: params.targetSummaryTokens,
      minSummaryTokens: params.minSummaryTokens,
      maxSummaryTokens: params.maxSummaryTokens,
      numCtx: params.numCtx,
      // The focus note is part of the short prompt too (it is rule 6), so it is
      // part of what has be measured. Measuring a focus-free prompt here
      // understated the request by the size of the note — measured at numCtx
      // 2048: 557 tokens without the note against 851 with it, a ~24 %
      // overstatement of the history budget that every chunk then inherited.
      ...(params.focus === undefined ? {} : { focus: params.focus }),
    },
    model
  );
  const shortHistoryBudget = computeEffectiveInputBudget(safeInputBudget, shortPromptTokens);
  if (shortHistoryBudget >= MIN_HISTORY_ALLOWANCE_TOKENS) {
    return {
      mode: 'short',
      historyBudget: shortHistoryBudget,
      // The short prompt carries no scope sentence, so the chunker gets the
      // same allowance.
      chunkHistoryBudget: shortHistoryBudget,
      promptTokens: shortPromptTokens,
    };
  }

  return null;
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
 * @param preservedRecentTokens - How many tokens of NEWER turns are preserved
 *                                OUTSIDE this summary (their large tool
 *                                outputs arrive as distilled digests).
 *                                `undefined` when the caller does not know;
 *                                the prompt then does not claim that the
 *                                summary is the only record of the older turns.
 * @param focus - The user's `/compact` note about what to keep. It reaches
 *                every prompt this function builds — the single pass, each
 *                chunk and every reduction round — because a note that only
 *                shaped one chunk would be diluted away by the merge.
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
  redactSecrets?: boolean | undefined,
  preservedRecentTokens?: number | undefined,
  focus?: string | undefined
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
  const serializedEstimate = countCalibratedTextTokens(
    serializeHistoryForSummaryText(preparedHistoryMessages, serializeOptions),
    model,
    'summarise'
  );

  const singlePassBudget = computeSummaryBudget(numCtx, aggressiveFactor, serializedEstimate);

  const promptParams = {
    targetSummaryTokens: singlePassBudget.targetSummaryTokens,
    minSummaryTokens: singlePassBudget.minSummaryTokens,
    maxSummaryTokens: singlePassBudget.maxSummaryTokens,
    ...(preservedRecentTokens === undefined ? {} : { preservedRecentTokens }),
    numCtx,
    // Carried in the params object so the focus paragraph is charged against
    // the safe input budget by the same measurement that charges the rest of
    // the prompt — a prompt that grew after it was measured would overflow.
    ...(focus === undefined ? {} : { focus }),
  };

  // The INSTRUCTION PROMPT is part of the request too, so it is paid for out
  // of the safe input budget before the history is fitted into what is left.
  // The prompt is measured with the SAME parameters that will be sent (the
  // single-pass budget is the largest budget a request can have, so the
  // subtraction is conservative for the per-chunk prompts as well).
  //
  // When the full prompt does not leave enough room for the history the
  // pipeline falls back to the SHORT prompt (the same six-section contract
  // without the explanation of the input format). When even that does not
  // fit, the compaction FAILS with a clear error instead of sending a
  // request the provider will reject.
  const plan = planSummarisationPrompt(safeInputBudget, model, promptParams);
  if (!plan) {
    throw new Error(
      `This context window is too small to compact (${numCtx} tokens): the summariser prompt alone ` +
        `needs more than the ${safeInputBudget}-token input budget, and a compaction needs at least ` +
        `${MIN_HISTORY_ALLOWANCE_TOKENS} tokens of history to summarise. Use a model with a larger ` +
        'context window, or continue the conversation without compacting.'
    );
  }
  const historyBudget = plan.historyBudget;
  const chunkHistoryBudget = plan.chunkHistoryBudget;
  const promptMode = plan.mode;

  if (serializedEstimate <= historyBudget) {
    return summariseChunk({
      ctx,
      model,
      numCtx,
      historyMessages: preparedHistoryMessages,
      budget: singlePassBudget,
      ...(preservedRecentTokens === undefined ? {} : { preservedRecentTokens }),
      promptMode,
      ...(onProgress ? { onProgress } : {}),
      ...(signal ? { signal } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(onTps ? { onTps } : {}),
      ...(toolNames ? { toolNames } : {}),
      redactSecrets: redactSecrets ?? true,
      maxToolResultChars,
      ...(focus === undefined ? {} : { focus }),
    });
  }

  const chunks = splitHistoryIntoChunks(
    preparedHistoryMessages,
    chunkHistoryBudget,
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
    const chunkSerializedEstimate = countCalibratedTextTokens(
      serializeHistoryForSummaryText(chunk, serializeOptions),
      model,
      'summarise'
    );
    const chunkBudget = computeSummaryBudget(numCtx, aggressiveFactor, chunkSerializedEstimate);
    const label = `chunk ${index + 1}/${chunks.length}`;
    const summary = await summariseChunk({
      ctx,
      model,
      numCtx,
      historyMessages: chunk,
      budget: chunkBudget,
      ...(preservedRecentTokens === undefined ? {} : { preservedRecentTokens }),
      promptMode,
      // The chunker knows how many slices there are: the prompt then says
      // that THIS request covers one slice and that the sibling slices are
      // summarised separately.
      chunkCount: chunks.length,
      chunkIndex: index + 1,
      label,
      ...(onProgress ? { onProgress } : {}),
      ...(signal ? { signal } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(onTps ? { onTps } : {}),
      ...(toolNames ? { toolNames } : {}),
      redactSecrets: redactSecrets ?? true,
      maxToolResultChars,
      ...(focus === undefined ? {} : { focus }),
    });
    chunkSummaries.push(summary);
  }

  onProgress?.('Reducing chunk summaries...');
  return reduceSummaryGroups(
    { ctx, model, numCtx, onProgress, signal, reasoningEffort, onTps },
    aggressiveFactor,
    chunkSummaries,
    focus
  );
}


/**
 * The token cost of everything a combine request carries BESIDES the partial
 * summaries: the combine prompt, the two message frames and the wrapper.
 *
 * The RETRY prompt is counted as well and the LARGER of the two is used: the
 * empty-response retry re-sends the same parts with the short prompt, and a
 * batch that fits with the combine prompt but not with the retry would blow
 * the window on the retry.
 *
 * The combine prompt is built with the SAME focus note the request will carry:
 * the note is extra text, so measuring the focus-free prompt would understate
 * the parts budget by exactly the size of the thing being added.
 *
 * @param model - the model the request goes to.
 * @param focus - the user's `/compact` note, or `undefined`.
 */
function countReductionRequestOverhead(model: string, focus?: string): number {
  const combineOverhead = countPromptOverhead(
    buildReductionCombineSystemPrompt(focus),
    REDUCTION_REQUEST_USER_PREFIX,
    model
  );
  const retryOverhead = countPromptOverhead(
    buildRetrySystemPrompt({
      // The largest budget the retry can be given, so the measured
      // overhead is an upper bound for every request.
      targetSummaryTokens: 1200,
      minSummaryTokens: 600,
      maxSummaryTokens: 1200,
      numCtx: 200000,
      ...(focus === undefined ? {} : { focus }),
    }),
    REDUCTION_REQUEST_USER_PREFIX,
    model
  );
  return Math.max(combineOverhead, retryOverhead);
}

/**
 * Combines partial summaries in bounded batches until a single summary remains.
 * Terminates when one summary is left; otherwise fans out into batches of
 * `REDUCTION_FAN_IN` and recurses on the resulting batch summaries.
 *
 * The batches are bounded by the safe input budget as well as by the fan-in
 * count: the combine request carries its own prompt, and that prompt is paid
 * for out of the budget before the parts are sent. A batch is never DROPPED —
 * a part that does not fit is sent on its own.
 *
 * The recursion ALWAYS terminates: the number of parts strictly decreases
 * every round (see `batchReductionParts`), and a hard cap of
 * {@link MAX_REDUCTION_ROUNDS} rounds merges the remaining parts without a
 * model call.
 */
export async function reduceSummaryGroups(
  call: CompactionLlmCall,
  aggressiveFactor: number,
  summaries: string[],
  focus?: string
): Promise<string> {
  const { model, numCtx, onProgress } = call;
  let current = summaries;

  // One round per pass. `!== 1` (not `> 1`) on purpose: an EMPTY list keeps
  // running rounds until the cap and returns '', exactly as the recursion this
  // loop replaced did.
  for (let round = 0; current.length !== 1; round += 1) {
    // The combine request's own prompt comes out of the safe input budget
    // first: what is left is what the partial summaries may use. (Counted every
    // round, never hoisted: the calibrated counts are only constant while the
    // caller holds the calibration pin.)
    const partsBudget = computeEffectiveInputBudget(
      computeSafeInputBudget(numCtx),
      countReductionRequestOverhead(model, focus)
    );

    const parts: ReductionPart[] = current.map((text, index) => ({ number: index + 1, text }));

    // The hard cap: after MAX_REDUCTION_ROUNDS the parts are merged WITHOUT a
    // model call. The reduction is lossy at every level, so this is the last
    // resort — but a summary that keeps every fact beats an endless loop.
    if (round >= MAX_REDUCTION_ROUNDS) {
      onProgress?.(
        `Reduction round limit reached (${MAX_REDUCTION_ROUNDS}) — merging the ${parts.length} ` +
          'remaining partial summaries without another model call.'
      );
      return concatenateReductionParts(parts);
    }

    const batches = batchReductionParts(parts, partsBudget, model);

    const batchSummaries: string[] = [];
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      if (!batch) {
        continue;
      }
      const label =
        batches.length > 1 ? `reduction group ${batchIndex + 1}/${batches.length}` : undefined;

      const batchText = buildReductionBatchText(batch);
      const batchMessages: ChatMessage[] = [
        {
          role: 'system',
          content: buildReductionCombineSystemPrompt(focus),
        },
        {
          role: 'user',
          content: `${REDUCTION_REQUEST_USER_PREFIX}${batchText}`,
        },
      ];

      const sourceEstimate = countMessagesTokens(batchMessages, model, 'summarise');
      const budget = computeSummaryBudget(numCtx, aggressiveFactor, sourceEstimate);
      onProgress?.(label ? `Reducing ${label}...` : 'Reducing summaries...');

      batchSummaries.push(await summariseMessages(call, batchMessages, batchText, budget, focus));
    }

    current = batchSummaries;
  }

  return current[0]!;
}
