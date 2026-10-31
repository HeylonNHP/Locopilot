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

import {
  computeEffectiveInputBudget,
  computeSafeInputBudget,
  computeSummaryBudget,
} from './budget';
import {
  MAX_REDUCTION_ROUNDS,
  MIN_HISTORY_ALLOWANCE_TOKENS,
  REDUCTION_COMBINE_SYSTEM_PROMPT,
  REDUCTION_FAN_IN,
  SUMMARY_SECTIONS,
} from './constants';
import { serializeHistoryForSummaryText, type SerializeHistoryOptions } from './serialize';
import { splitHistoryIntoChunks } from './split';
import {
  type BuildCompactSystemPromptParams,
  buildRetrySystemPrompt,
  countRetryPromptTokens,
  countSummarisationPromptTokens,
  summariseChunk,
  summariseMessages,
  type SummaryPromptMode,
} from './summarize';

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
  preservedRecentTokens?: number | undefined
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

  const singlePassBudget = computeSummaryBudget(numCtx, aggressiveFactor, serializedEstimate);

  const promptParams = {
    targetSummaryTokens: singlePassBudget.targetSummaryTokens,
    minSummaryTokens: singlePassBudget.minSummaryTokens,
    maxSummaryTokens: singlePassBudget.maxSummaryTokens,
    ...(preservedRecentTokens === undefined ? {} : { preservedRecentTokens }),
    numCtx,
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

/** One partial summary on its way into a combine request. */
export interface ReductionPart {
  /** The number the part is labelled with (`[PART n]:`). */
  number: number;
  /** The partial summary itself. */
  text: string;
}

/**
 * The text of one combine request: the labelled parts, joined by a blank
 * line.
 */
function buildReductionBatchText(parts: ReductionPart[]): string {
  return parts.map((part) => `[PART ${part.number}]:\n${part.text}`).join('\n\n');
}

/**
 * The fixed prefix of the combine request's user message.
 */
const REDUCTION_REQUEST_USER_PREFIX =
  'Combine the following partial summaries into one coherent summary:\n\n';

/**
 * The token cost of everything a combine request carries BESIDES the partial
 * summaries: the combine prompt, the two message frames and the wrapper.
 *
 * The RETRY prompt is counted as well and the LARGER of the two is used: the
 * empty-response retry re-sends the same parts with the short prompt, and a
 * batch that fits with the combine prompt but not with the retry would blow
 * the window on the retry.
 */
function countReductionRequestOverhead(model: string): number {
  const combineOverhead = countMessagesTokens(
    [
      { role: 'system', content: REDUCTION_COMBINE_SYSTEM_PROMPT },
      { role: 'user', content: REDUCTION_REQUEST_USER_PREFIX },
    ],
    model
  );
  const retryOverhead = countMessagesTokens(
    [
      {
        role: 'system',
        content: buildRetrySystemPrompt({
          // The largest budget the retry can be given, so the measured
          // overhead is an upper bound for every request.
          targetSummaryTokens: 1200,
          minSummaryTokens: 600,
          maxSummaryTokens: 1200,
          numCtx: 200000,
        }),
      },
      { role: 'user', content: REDUCTION_REQUEST_USER_PREFIX },
    ],
    model
  );
  return Math.max(combineOverhead, retryOverhead);
}

/**
 * Builds the batches for ONE reduction round.
 *
 * The batches are bounded by the parts budget (what is left of the safe input
 * budget once the combine prompt is paid for) as well as by the fan-in
 * count. A part that does not fit is sent on its own — nothing is ever
 * DROPPED.
 *
 * WHY the pairing fallback exists: when EVERY part is bigger than half the
 * parts budget, each batch holds exactly ONE part, so the number of parts
 * would not shrink and the recursion would repeat for ever — one model call
 * per part per round, with no termination (measured: 51 → 26 → 26 → 26… at a
 * 2048-token context, and no progress at all at 1024). The count MUST
 * strictly decrease every round, so when the budget-based batching does not
 * shrink it, the parts are merged in PAIRS for that round — the budget is
 * ignored for that round, because a pair of partial summaries is the
 * smallest unit that can shrink. The count then at least halves.
 *
 * Exported so the guarantee can be tested without a model call.
 */
export function batchReductionParts(
  parts: ReductionPart[],
  partsBudget: number,
  model: string
): ReductionPart[][] {
  if (parts.length === 0) {
    return [];
  }
  if (parts.length === 1) {
    return [[parts[0]!]];
  }

  const batches: ReductionPart[][] = [];
  let current: ReductionPart[] = [];
  for (const part of parts) {
    const candidate = [...current, part];
    const candidateTokens = countTextTokens(buildReductionBatchText(candidate), model);
    const exceedsFanIn = current.length >= REDUCTION_FAN_IN;
    const exceedsBudget = current.length > 0 && candidateTokens > partsBudget;
    if (exceedsFanIn || exceedsBudget) {
      batches.push(current);
      current = [part];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    batches.push(current);
  }

  // The progress guarantee: the round must produce FEWER batches than there
  // were parts, or the recursion would never end.
  if (batches.length >= parts.length) {
    return pairReductionParts(parts);
  }
  return batches;
}

/**
 * Merges the parts in PAIRS — the fallback that guarantees the count at
 * least halves.
 */
function pairReductionParts(parts: ReductionPart[]): ReductionPart[][] {
  const batches: ReductionPart[][] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const first = parts[index];
    if (!first) {
      continue;
    }
    const second = parts[index + 1];
    batches.push(second ? [first, second] : [first]);
  }
  return batches;
}

/**
 * A line that opens a section of a structured summary.
 */
const REDUCTION_SECTION_LINE = /^([A-Z][A-Za-z]*(?: [A-Za-z]+)*):/;

/**
 * The marker that separates two merged pieces in the final concatenation.
 */
const REDUCTION_CONCATENATION_MARKER = ' | ';

/**
 * Splits one partial summary into its leading text and its sections.
 */
function splitReductionPart(text: string): { lead: string; sections: [string, string][] } {
  const leadLines: string[] = [];
  const sections: [string, string][] = [];
  let currentName: string | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentName === null) {
      return;
    }
    const body = currentLines.join('\n').trim();
    if (body.length > 0) {
      sections.push([currentName, body]);
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const match = REDUCTION_SECTION_LINE.exec(line);
    const label = match?.[1];
    if (label) {
      flush();
      currentName = label;
      currentLines = [line.slice(match[0].length).trim()];
      continue;
    }
    if (currentName === null) {
      leadLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return { lead: leadLines.join('\n').trim(), sections };
}

/**
 * Merges the remaining partial summaries into ONE text WITHOUT a model call.
 *
 * This is the last resort of the reduction: the parts are merged section by
 * section (so the result keeps the shape of a structured summary) and a short
 * marker separates two pieces that came from different parts. Each piece
 * keeps its OWN section label, so every part's text survives the merge
 * verbatim — nothing is dropped, and every piece can still be read on its
 * own.
 *
 * Exported so the "no part is dropped" property can be tested offline.
 */
export function concatenateReductionParts(parts: ReductionPart[]): string {
  const leads: string[] = [];
  const bySection = new Map<string, string[]>();

  for (const part of parts) {
    const { lead, sections } = splitReductionPart(part.text);
    if (lead.length > 0) {
      leads.push(lead);
    }
    for (const [name, body] of sections) {
      // The piece keeps its own label: the merge must not lose the fact
      // that the text belongs to that section.
      const piece = `${name}: ${body}`;
      const pieces = bySection.get(name);
      if (pieces) {
        pieces.push(piece);
      } else {
        bySection.set(name, [piece]);
      }
    }
  }

  const blocks: string[] = [];
  if (leads.length > 0) {
    blocks.push(leads.join(REDUCTION_CONCATENATION_MARKER));
  }
  for (const section of SUMMARY_SECTIONS) {
    const pieces = bySection.get(section);
    if (!pieces || pieces.length === 0) {
      continue;
    }
    blocks.push(pieces.join(REDUCTION_CONCATENATION_MARKER));
  }
  // A section that is not one of the six (a part that used a different
  // label) must not be dropped either.
  for (const [name, pieces] of bySection) {
    if ((SUMMARY_SECTIONS as readonly string[]).includes(name)) {
      continue;
    }
    blocks.push(pieces.join(REDUCTION_CONCATENATION_MARKER));
  }

  return blocks.join('\n\n');
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
  return reduceSummaryGroupsAtRound(
    ctx,
    model,
    numCtx,
    aggressiveFactor,
    summaries,
    0,
    onProgress,
    signal,
    reasoningEffort,
    onTps
  );
}

/**
 * One reduction round, with the round counter that bounds the recursion.
 */
async function reduceSummaryGroupsAtRound(
  ctx: LlmRequestContext,
  model: string,
  numCtx: number,
  aggressiveFactor: number,
  summaries: string[],
  round: number,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  onTps?: (tps: number) => void
): Promise<string> {
  if (summaries.length === 1) {
    return summaries[0]!;
  }

  // The combine request's own prompt comes out of the safe input budget
  // first: what is left is what the partial summaries may use.
  const partsBudget = computeEffectiveInputBudget(
    computeSafeInputBudget(numCtx),
    countReductionRequestOverhead(model)
  );

  const parts: ReductionPart[] = summaries.map((text, index) => ({ number: index + 1, text }));

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
        content: REDUCTION_COMBINE_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: `${REDUCTION_REQUEST_USER_PREFIX}${batchText}`,
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

  return reduceSummaryGroupsAtRound(
    ctx,
    model,
    numCtx,
    aggressiveFactor,
    batchSummaries,
    round + 1,
    onProgress,
    signal,
    reasoningEffort,
    onTps
  );
}
