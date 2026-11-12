/**
 * types.ts
 *
 * Shared types for the compaction pipeline. Kept separate so every module can
 * rely on the same shapes without importing from the orchestrator (avoiding
 * circular dependencies).
 */

import type { ChatMessage, LlmRequestContext } from '@/services/llm';
import type { ReasoningEffort } from '@/types/chatConfig';

/** Token counts for a single compaction pass, used for display/telemetry. */
export interface CompactStats {
  oldTokenCount: number;
  newTokenCount: number;
}

/** Result of a compaction pass: the new history plus token stats. */
export interface CompactResult {
  /** The new, compacted message array that should replace the live history. */
  newMessages: ChatMessage[];
  /** Token counts for display purposes. */
  stats: CompactStats;
}

/** How the history was divided between "to summarise" and "preserve recent". */
export interface HistorySplit {
  messagesToSummarise: ChatMessage[];
  preservedRecentMessages: ChatMessage[];
  preservedRecentTokens: number;
}

/** Token budget computed for a single summarisation request. */
export interface SummaryBudget {
  targetSummaryTokens: number;
  minSummaryTokens: number;
  maxSummaryTokens: number;
}

/**
 * Maps a tool-call id to the name of the tool that produced it.
 *
 * Built from the FULL conversation, not from the slice being summarised: a
 * tool result can outlive the assistant row that issued it (the history split
 * may bisect an assistant+tool block), so the name has to be resolvable even
 * when the owning assistant is not part of the summarised slice.
 */
export type ToolNameMap = Map<string, string>;

/**
 * What every model call of the compaction pipeline needs, as ONE object instead
 * of seven positional parameters: where the call goes (`ctx`, `model`), the
 * window it runs against, and the three things a caller may pass along (progress,
 * abort, the live tokens-per-second reporter) plus the reasoning effort.
 *
 * The optional members are `| undefined` on purpose: the pipeline forwards what
 * it was given without rebuilding the object, and `exactOptionalPropertyTypes`
 * would otherwise make every forward a conditional spread.
 */
export interface CompactionLlmCall {
  ctx: LlmRequestContext;
  model: string;
  /** The model's context window. */
  numCtx: number;
  /** Progress lines for the UI. */
  onProgress?: ((message: string) => void) | undefined;
  /** The caller's abort signal: an abort is a user decision and always propagates. */
  signal?: AbortSignal | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  /** The live generation-speed reporter (tokens per second). */
  onTps?: ((tps: number) => void) | undefined;
}
