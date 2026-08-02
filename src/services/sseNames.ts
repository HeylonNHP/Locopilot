/**
 * Centralised names for chat SSE events, status phases, and done reasons.
 *
 * The producer (`src/app/api/chat/route.ts`) and the consumer (`useChatStream.ts`,
 * `useSlashCommands.ts`) used to refer to these literals as bare strings, while
 * the payload shape itself was typed in `src/types/sse.ts`. Centralising the
 * names makes a typo at any call site a compile-time error and lets new
 * producers/consumers stay in sync with the typed payload map.
 */

import type { SseEventPayloadMap } from '@/types/sse';

/**
 * Every SSE event name emitted by the chat stream. The union mirrors the keys
 * of `SseEventPayloadMap` exactly so the producer's `sendEvent<N>(event: N, …)`
 * signature stays well-typed at every call site.
 */
export type SseEventName = keyof SseEventPayloadMap;

/**
 * Concrete `as const` tuple so callers that want to iterate the set (e.g. for
 * a metric counter, a test fixture, or a docs page) can do so without
 * hard-coding the strings.
 */
export const SSE_EVENT_NAMES = [
  'session_created',
  'thinking',
  'chunk',
  'tool_call',
  'tool_result',
  'tool_progress',
  'subagent_output',
  'subagent_chunk',
  'approval_request',
  'status',
  'compact_progress',
  'compact',
  'done',
  'error',
  'write_error',
  'clear_assistant',
] as const satisfies readonly SseEventName[];

/** Wrapper event name for the MCP events SSE endpoint. */
export const MCP_SSE_EVENT_NAME = 'mcp-state';

// ── `status.phase` ─────────────────────────────────────────────────────────

/**
 * Phases the chat route can advertise via the `status` event's `phase`
 * field. Was previously typed as `phase: string` on the payload map, which
 * meant callers had to check magic strings without compile-time help.
 */
export type ChatPhase =
  | 'compacting'
  | 'compact_overflow'
  | 'compact_failed'
  | 'thinking'
  | 'responding'
  | 'retrying'
  | 'tools'
  | 'subagent'
  | 'truncated'
  | 'completeness-check'
  | 'context_limit_adjusted'
  | 'vision_unsupported';

export const CHAT_PHASES: readonly ChatPhase[] = [
  'compacting',
  'compact_overflow',
  'compact_failed',
  'thinking',
  'responding',
  'retrying',
  'tools',
  'subagent',
  'truncated',
  'completeness-check',
  'context_limit_adjusted',
  'vision_unsupported',
];

// ── `done.doneReason` ──────────────────────────────────────────────────────

/**
 * Values the chat `done` event emits for `doneReason`. Mirrors the Ollama
 * native field but also covers the `'unknown'` client-side fallback and the
 * `'error'` adapter error path so every consumer-side check is exhaustive.
 */
export type DoneReason = 'stop' | 'length' | 'load' | 'unload' | 'unknown' | 'error';

/** Subset of `DoneReason` that the producer validates against (excludes `'error'`/`'unknown'`). */
export const VALID_DONE_REASONS: readonly DoneReason[] = ['stop', 'length', 'load', 'unload'];

/** Alias used by `useChatStream.ts` for the consumer-side superset. */
export const DONE_REASONS: readonly DoneReason[] = VALID_DONE_REASONS;

// ── `subagent_chunk.type` ──────────────────────────────────────────────────

/** Discriminator on the `subagent_chunk` SSE event. */
export type SubagentChunkType = 'thinking' | 'content';
