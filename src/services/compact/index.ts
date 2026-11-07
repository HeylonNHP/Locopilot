/**
 * index.ts
 *
 * Public entry point for the compaction pipeline. Re-exports the public
 * `compactHistory` function, its types, and the pure trigger/verdict helpers
 * the callers gate on, so existing callers can keep importing from
 * '@/services/compact' without knowing about the internal module layout.
 */

export {
  type CompactionSizeVerdict,
  computeCompactionReserveTokens,
  computeCompactionTriggerTokens,
  computeDistillCallCap,
  evaluateCompactionSizes,
} from './budget';
export { SYNTHETIC_NUDGE_MARKER } from './constants';
export {
  COMPACTION_ADAPTIVE_DIRECTIVE,
  COMPACTION_ADAPTIVE_DIRECTIVE_THRESHOLD,
  COMPACTION_INITIAL_DIRECTIVE,
  SYNTHETIC_NUDGE_END,
} from './constants';
export { compactHistory } from './orchestrate';
export type { CompactResult, CompactStats } from './types';
export { planWindowTrim, type WindowTrimPlan, type WindowTrimStopReason } from './windowTrim';
