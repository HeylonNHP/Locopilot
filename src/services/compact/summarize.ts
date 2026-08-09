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

import { type ChatMessage, type LlmRequestContext, sendLlmChatStream } from '@/services/llm';

import type { SummaryBudget } from './types';

import { SUMMARY_NUM_PREDICT_BUFFER_RATIO } from './constants';

interface BuildCompactSystemPromptParams {
  targetSummaryTokens: number;
  minSummaryTokens: number;
  maxSummaryTokens: number;
  preservedRecentTokens: number;
  numCtx: number;
}

// The instruction sent to the LLM when asking it to compact a chunk of history.
function buildCompactSystemPrompt(params: BuildCompactSystemPromptParams): string {
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

async function streamSummary(
  ctx: LlmRequestContext,
  model: string,
  messages: ChatMessage[],
  numCtx: number,
  numPredict: number | undefined,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort
): Promise<string> {
  let text = '';
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
    const content = chunk.message?.content ?? '';
    if (content.length > 0) {
      text += content;
      onProgress?.(`AI is summarizing... (${text.length} chars)`);
    }
  }
  return text.trim();
}

interface SummariseChunkParams {
  ctx: LlmRequestContext;
  model: string;
  numCtx: number;
  historyMessages: ChatMessage[];
  budget: SummaryBudget;
  /** Informational only — how many tokens are preserved verbatim outside this chunk. */
  preservedRecentTokens: number;
  /** Optional human-readable label for progress messages (e.g. "chunk 3/12"). */
  label?: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
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
    label,
    onProgress,
    signal,
    reasoningEffort,
  } = params;

  const historyText = historyMessages
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content ?? ''}`)
    .join('\n\n');

  const prefix = label ? `${label} — ` : '';

  const summarisationMessages: ChatMessage[] = [
    {
      role: 'system',
      content: buildCompactSystemPrompt({
        targetSummaryTokens: budget.targetSummaryTokens,
        minSummaryTokens: budget.minSummaryTokens,
        maxSummaryTokens: budget.maxSummaryTokens,
        preservedRecentTokens,
        numCtx,
      }),
    },
    {
      role: 'user',
      content: `Please summarise the following conversation history:\n\n${historyText}`,
    },
  ];

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
    reasoningEffort
  );
}

/**
 * Low-level bounded summarisation of an already-constructed message set. Used by
 * `summariseChunk` for history chunks and by the reduce step for combining
 * partial summaries. Retries once with a simplified prompt if the model returns
 * nothing.
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
  reasoningEffort?: ReasoningEffort
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
    reasoningEffort
  );

  // If the model returned nothing (can happen with very small inputs and a
  // large target), retry once with a dead-simple prompt and no token cap.
  if (!text) {
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
        content: `Summarise this conversation:\n\n${sourceText}`,
      },
    ];
    text = await streamSummary(
      ctx,
      model,
      retryMessages,
      numCtx,
      undefined,
      onProgress,
      signal,
      reasoningEffort
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
