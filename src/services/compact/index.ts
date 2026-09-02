/**
 * index.ts
 *
 * Public entry point for the compaction pipeline. Re-exports the public
 * `compactHistory` function and its types so existing callers can keep
 * importing from '@/services/compact' without knowing about the internal module
 * layout.
 */

export { SYNTHETIC_NUDGE_MARKER } from './constants';
export {
  COMPACTION_ADAPTIVE_DIRECTIVE,
  COMPACTION_ADAPTIVE_DIRECTIVE_THRESHOLD,
  SYNTHETIC_NUDGE_END,
} from './constants';
export { compactHistory } from './orchestrate';
export type { CompactResult, CompactStats } from './types';
