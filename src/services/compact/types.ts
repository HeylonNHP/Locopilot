/**
 * types.ts
 *
 * Shared types for the compaction pipeline. Kept separate so every module can
 * rely on the same shapes without importing from the orchestrator (avoiding
 * circular dependencies).
 */

import type { ChatMessage } from '@/services/llm';

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
