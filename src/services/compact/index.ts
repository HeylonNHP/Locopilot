/**
 * index.ts
 *
 * Public entry point for the compaction pipeline. Re-exports the public
 * `compactHistory` function and its types so existing callers can keep
 * importing from '@/services/compact' without knowing about the internal module
 * layout.
 */

export { compactHistory } from './orchestrate';
export type { CompactResult, CompactStats } from './types';
