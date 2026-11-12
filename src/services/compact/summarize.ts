/**
 * summarize.ts
 *
 * Bounded summarisation requests for the compaction pipeline. The key primitive
 * is `summariseChunk`: a single LLM request that summarises a message array
 * which is guaranteed (by the caller) to fit within a safe input budget. The
 * same primitive powers both the single-shot path and every chunk/reduction
 * step of the map-reduce path, so all requests stay bounded.
 */

import type { ReasoningEffort } from '@/types/chatConfig';

import { TPS_STATUS_MIN_INTERVAL_MS } from '@/constants';
import {
  type ChatApiResponse,
  type ChatMessage,
  getLlmTurnStats,
  type LlmRequestContext,
  sendLlmChatStream,
} from '@/services/llm';
import { recordTokenCalibrationSample } from '@/services/tokenCalibration';
import { countMessagesTokens, countRawMessagesTokens } from '@/services/tokenizer';
import { LiveThroughputMeter } from '@/services/tokenThroughput';

import type { SummaryBudget, ToolNameMap } from './types';

import { SUMMARY_NUM_PREDICT_BUFFER_RATIO } from './constants';
import { serializeHistoryForSummaryText, type SerializeHistoryOptions } from './serialize';
import {
  buildCompactSystemPrompt,
  type BuildCompactSystemPromptParams,
  buildRetrySystemPrompt,
  type BuildRetrySystemPromptParams,
  SUMMARY_REQUEST_USER_PREFIX,
  SUMMARY_RETRY_USER_PREFIX,
  type SummaryPromptMode,
} from './summaryPrompt';

/**
 * The token cost of everything a summarisation request carries BESIDES the
 * history: the instruction prompt, the two message frames and the wrapper.
 *
 * The prompt is part of the request, so it has to be paid for out of the safe
 * input budget BEFORE the history is fitted into what is left — a prompt of a
 * few hundred tokens is a large share of a small context window.
 *
 * The measurement uses the SAME prompt parameters that will be sent, and the
 * repo's own tokenizer.
 *
 * ONE UNIT SYSTEM: the prompt is measured in the `summarise` class, which is
 * the same class the serialised HISTORY is measured in (see
 * `estimateSerializedMessageTokens` in `reduce.ts`). The budget this prompt is
 * paid out of is a number of provider tokens, so both terms of the
 * subtraction have to be in provider tokens, and both have to be measured the
 * way a summariser request is actually shaped.
 */
export function countSummarisationPromptTokens(
  params: BuildCompactSystemPromptParams,
  model: string
): number {
  return countPromptOverhead(buildCompactSystemPrompt(params), SUMMARY_REQUEST_USER_PREFIX, model);
}

/**
 * The token cost of a request's FRAME: one system prompt and the fixed prefix of
 * the user message, in the `summarise` class.
 *
 * ONE helper for every place that charges a prompt against the safe input
 * budget (the full prompt, the short prompt, and both halves of the reduction's
 * combine overhead in `reduce.ts`), so they all measure the same way.
 */
export function countPromptOverhead(system: string, userPrefix: string, model: string): number {
  return countMessagesTokens(
    [
      { role: 'system', content: system },
      { role: 'user', content: userPrefix },
    ],
    model,
    'summarise'
  );
}

/**
 * The token cost of the SHORT prompt (and of the empty-response retry).
 *
 * The short prompt is what the pipeline falls back to when the full prompt
 * does not fit into the context window, so its cost has to be measured with
 * the same tokenizer and the same wrapper — the budget arithmetic must never
 * be done against a number that is not the one that will be sent.
 *
 * The class is `summarise`, like the full prompt's: the two are subtracted
 * from the same budget as the serialised history.
 */
export function countRetryPromptTokens(
  params: BuildRetrySystemPromptParams,
  model: string
): number {
  return countPromptOverhead(buildRetrySystemPrompt(params), SUMMARY_REQUEST_USER_PREFIX, model);
}

async function streamSummary(
  ctx: LlmRequestContext,
  model: string,
  messages: ChatMessage[],
  numCtx: number,
  numPredict: number | undefined,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  onTps?: (tps: number) => void
): Promise<string> {
  let text = '';
  // The terminal chunk of the stream — the one that carries the provider's
  // PROMPT count. Kept so the calibration sample below can read it.
  let lastChunk: ChatApiResponse | undefined;
  // Live t/s meter so the UI can show generation speed while compaction runs
  // (same shared policy as the main loop: rebaseline at first token, min
  // interval, minimum measurement window). Fresh meter per attempt so the
  // empty-response retry starts its own measurement.
  const liveMeter = new LiveThroughputMeter(model, TPS_STATUS_MIN_INTERVAL_MS);
  for await (const chunk of sendLlmChatStream(ctx, {
    model,
    messages,
    tools: [],
    numCtx,
    ...(numPredict === undefined ? {} : { maxOutputTokens: numPredict }),
    options: {
      temperature: 0,
    },
    ...(signal ? { signal } : {}),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  })) {
    lastChunk = chunk;
    const content = chunk.message?.content ?? '';
    if (content.length > 0) {
      text += content;
      liveMeter.onText(content);
      onProgress?.(`AI is summarizing... (${text.length} chars)`);
    }
    liveMeter.maybeReport((tps) => onTps?.(tps));
  }

  // ── Calibration sample (the summariser request) ──
  //
  // A CLEAN sample: the request carries `tools: []`, so the provider's prompt
  // count and our own count describe the SAME thing — the messages sent — and
  // nothing has to be subtracted from the provider's side. The PROMPT count
  // only; `eval_count` is the generated summary and is not part of the
  // request's cost.
  //
  // This is the sample that calibrates the COMPACTION model, which may be a
  // different model from the one the main chat turn uses — the cache is keyed
  // on the provider and the model, so each model learns its own factor.
  //
  // The class is `summarise`: a summarisation request is ONE big blob plus a
  // system prompt, so it pays the provider's per-message framing once — not
  // once per message, the way a chatty chat request does. Its factor is
  // therefore its own, and it cannot contaminate the chat factor (nor the
  // other way round).
  //
  // Best-effort: a calibration that cannot be recorded must never break a
  // compaction.
  try {
    if (lastChunk) {
      const stats = getLlmTurnStats(ctx, lastChunk);
      if (stats) {
        recordTokenCalibrationSample({
          model,
          provider: ctx.provider ?? 'ollama',
          class: 'summarise',
          estimatedTokens: countRawMessagesTokens(messages, model),
          authoritativeTokens: stats.promptEvalCount,
          overheadTokens: 0,
          hasImages: false,
        });
      }
    }
  } catch {
    // Calibration is best-effort: a failure here must not fail the compaction.
  }

  return text.trim();
}

interface SummariseChunkParams {
  ctx: LlmRequestContext;
  model: string;
  numCtx: number;
  historyMessages: ChatMessage[];
  budget: SummaryBudget;
  /**
   * Informational only — how many tokens are preserved OUTSIDE this chunk
   * (the newer turns). `undefined` when the caller does not know, which keeps
   * the prompt from claiming that the summary is the only record of the older
   * turns.
   */
  preservedRecentTokens?: number;
  /**
   * Which system prompt the request carries. `short` is used when the full
   * prompt does not fit into the context window.
   */
  promptMode?: SummaryPromptMode;
  /**
   * How many slices the older history was split into. Above 1 the prompt
   * says that this request covers ONE slice and that the sibling slices are
   * summarised separately.
   */
  chunkCount?: number;
  /** The index of this slice (1-based). */
  chunkIndex?: number;
  /** The user's `/compact` focus note — see {@link BuildCompactSystemPromptParams.focus}. */
  focus?: string;
  /** Optional human-readable label for progress messages (e.g. "chunk 3/12"). */
  label?: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  /** Optional live t/s reporter so the UI can show compaction speed. */
  onTps?: (tps: number) => void;
  /**
   * Tool-call id → tool name, built from the FULL conversation. Threaded
   * through so a tool result that outlived its assistant row still renders
   * with the name of the tool that produced it.
   */
  toolNames?: ToolNameMap;
  /**
   * Whether secrets are redacted out of the projected arguments AND the tool
   * results. Defaults to true — the same default as `Config.redactSecrets`.
   */
  redactSecrets?: boolean;
  /**
   * The cap for the text of one tool result. Defaults to the serialiser's own
   * default (8000 characters).
   */
  maxToolResultChars?: number;
}

/** The request the summariser receives for one chunk of history. */
export interface SummarisationInput {
  /** The exact messages handed to the model. */
  messages: ChatMessage[];
  /** The serialised history text — also the source of the empty-response retry. */
  historyText: string;
}

/** The optional extras of {@link buildSummarisationInput}. */
export interface BuildSummarisationInputExtras {
  /**
   * Which system prompt the request carries. `short` drops the explanation
   * of the input format (the same six-section contract stays).
   */
  promptMode?: SummaryPromptMode;
  /** How many slices the older history was split into (1 = not split). */
  chunkCount?: number;
  /** The index of this slice (1-based). */
  chunkIndex?: number;
  /** The user's `/compact` focus note — see {@link BuildCompactSystemPromptParams.focus}. */
  focus?: string;
}

/**
 * Builds the summarisation request for a chunk of history.
 *
 * The history is rendered with the tool-aware serialiser, so the model sees
 * the ACTION (which command was run, which file was written) next to the
 * OUTPUT (the tool result) instead of a flat list of role/content pairs that
 * silently dropped every tool call.
 *
 * The `options` carry the three policies the serialiser needs: the tool-name
 * map, the redaction switch and the cap for a tool result.
 *
 * Exported so the exact request can be inspected without issuing a model
 * call — the compaction pipeline has no other seam for that.
 */
export function buildSummarisationInput(
  historyMessages: ChatMessage[],
  budget: SummaryBudget,
  preservedRecentTokens: number | undefined,
  numCtx: number,
  options?: SerializeHistoryOptions,
  extras?: BuildSummarisationInputExtras
): SummarisationInput {
  const historyText = serializeHistoryForSummaryText(historyMessages, options);

  const promptMode = extras?.promptMode ?? 'full';
  const system =
    promptMode === 'short'
      ? buildRetrySystemPrompt({
          targetSummaryTokens: budget.targetSummaryTokens,
          minSummaryTokens: budget.minSummaryTokens,
          maxSummaryTokens: budget.maxSummaryTokens,
          numCtx,
          ...(extras?.focus === undefined ? {} : { focus: extras.focus }),
        })
      : buildCompactSystemPrompt({
          targetSummaryTokens: budget.targetSummaryTokens,
          minSummaryTokens: budget.minSummaryTokens,
          maxSummaryTokens: budget.maxSummaryTokens,
          ...(preservedRecentTokens === undefined ? {} : { preservedRecentTokens }),
          numCtx,
          ...(extras?.chunkCount === undefined ? {} : { chunkCount: extras.chunkCount }),
          ...(extras?.chunkIndex === undefined ? {} : { chunkIndex: extras.chunkIndex }),
          ...(extras?.focus === undefined ? {} : { focus: extras.focus }),
        });

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: system,
    },
    {
      role: 'user',
      content: `${SUMMARY_REQUEST_USER_PREFIX}${historyText}`,
    },
  ];

  return { messages, historyText };
}

/**
 * Summarises a bounded chunk of history in a single request. Callers must
 * guarantee `historyMessages` fits within the safe input budget.
 */
export async function summariseChunk(params: SummariseChunkParams): Promise<string> {
  const {
    ctx,
    model,
    numCtx,
    historyMessages,
    budget,
    preservedRecentTokens,
    promptMode,
    chunkCount,
    chunkIndex,
    focus,
    label,
    onProgress,
    signal,
    reasoningEffort,
    onTps,
    toolNames,
    redactSecrets,
    maxToolResultChars,
  } = params;

  // The summariser sees the tool-aware serialisation of the history: the
  // action (which command ran, which file was edited) next to the output.
  const { messages: summarisationMessages, historyText } = buildSummarisationInput(
    historyMessages,
    budget,
    preservedRecentTokens,
    numCtx,
    {
      ...(toolNames ? { toolNames } : {}),
      redactSecrets: redactSecrets ?? true,
      ...(maxToolResultChars === undefined ? {} : { maxToolResultChars }),
    },
    {
      ...(promptMode === undefined ? {} : { promptMode }),
      ...(chunkCount === undefined ? {} : { chunkCount }),
      ...(chunkIndex === undefined ? {} : { chunkIndex }),
      ...(focus === undefined ? {} : { focus }),
    }
  );

  const prefix = label ? `${label} — ` : '';

  const forwardProgress = (message: string): void => onProgress?.(`${prefix}${message}`);

  return summariseMessages(
    ctx,
    model,
    numCtx,
    summarisationMessages,
    historyText,
    budget,
    forwardProgress,
    signal,
    reasoningEffort,
    onTps,
    focus
  );
}

/**
 * Low-level bounded summarisation of an already-constructed message set. Used by
 * `summariseChunk` for history chunks and by the reduce step for combining
 * partial summaries. Retries once with the same section contract, in short
 * form, if the model returns nothing.
 */
export async function summariseMessages(
  ctx: LlmRequestContext,
  model: string,
  numCtx: number,
  messages: ChatMessage[],
  sourceText: string,
  budget: SummaryBudget,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  onTps?: (tps: number) => void,
  /**
   * The user's `/compact` focus note.
   *
   * WHY it reaches this low-level function: the empty-response retry builds
   * its OWN system prompt, and a retry that dropped the note would produce a
   * summary shaped by a different brief from the one the user asked for — the
   * same reason the retry keeps the six-section contract.
   */
  focus?: string
): Promise<string> {
  const summaryNumPredict = Math.min(
    numCtx,
    Math.max(
      Math.floor(budget.targetSummaryTokens * SUMMARY_NUM_PREDICT_BUFFER_RATIO),
      budget.minSummaryTokens
    )
  );

  let text = await streamSummary(
    ctx,
    model,
    messages,
    numCtx,
    summaryNumPredict,
    onProgress,
    signal,
    reasoningEffort,
    onTps
  );

  // If the model returned nothing (can happen with very small inputs and a
  // large target), retry once with the same section contract in short form.
  // The retry must not fall back to prose: the summary is re-sent on every
  // later turn, and a summary in a different shape is a summary the next
  // reader has to learn again.
  //
  // The retry is CAPPED like the first attempt: an uncapped output at a
  // small context window asks for more tokens than the window can hold, and
  // an unbounded summary is what feeds the reduction's blow-up (a partial
  // summary that is bigger than the whole parts budget cannot be merged with
  // any other one). The same budget the normal path uses is applied.
  if (!text) {
    onProgress?.('Empty response — retrying with simplified prompt...');
    const retryMessages: ChatMessage[] = [
      {
        role: 'system',
        content: buildRetrySystemPrompt({
          targetSummaryTokens: budget.targetSummaryTokens,
          minSummaryTokens: budget.minSummaryTokens,
          maxSummaryTokens: budget.maxSummaryTokens,
          numCtx,
          ...(focus === undefined ? {} : { focus }),
        }),
      },
      {
        role: 'user',
        content: `${SUMMARY_RETRY_USER_PREFIX}${sourceText}`,
      },
    ];
    text = await streamSummary(
      ctx,
      model,
      retryMessages,
      numCtx,
      summaryNumPredict,
      onProgress,
      signal,
      reasoningEffort,
      onTps
    );
  }

  if (!text) {
    throw new Error(
      'The model returned an empty summary after two attempts. ' +
        'Try a different model or continue the conversation before compacting.'
    );
  }

  return text;
}
