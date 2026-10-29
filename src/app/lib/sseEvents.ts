import type { SseEventName } from '@/services/sseNames';

/**
 * What the client does with an SSE event when the user has navigated away
 * from the session the event belongs to.
 *
 * `replayable` events are held in memory and re-applied when the user comes
 * back, because nothing else will restore them: the live text only exists
 * in the client until the turn ends.
 *
 * `persisted` events describe something the server has already written to
 * the database — tool calls, tool results, compaction — so replaying them on
 * return would duplicate rows that the reload from the database already
 * brings back.
 *
 * `meta` events carry no content of their own (the session was created, the
 * turn ended) and are handled by the owner of the stream.
 */
export type SseEventClass = 'replayable' | 'persisted' | 'meta';

/**
 * The classification of every event the server can send.
 *
 * `satisfies` makes this exhaustive: adding an event to the payload map
 * without classifying it here is a compile error, and a misspelled key is
 * rejected too. The previous implementation was a plain `Set` of event
 * names, so a new event silently fell into "not replayed".
 */
export const SSE_EVENT_CLASSES = {
  session_created: 'meta',
  thinking: 'replayable',
  chunk: 'replayable',
  tool_call: 'persisted',
  tool_result: 'persisted',
  tool_progress: 'replayable',
  subagent_output: 'persisted',
  subagent_chunk: 'replayable',
  approval_request: 'replayable',
  status: 'replayable',
  compact_progress: 'replayable',
  compact: 'persisted',
  done: 'replayable',
  error: 'meta',
  write_error: 'meta',
  clear_assistant: 'meta',
} satisfies Record<SseEventName, SseEventClass>;

/**
 * Classify an event name. Unknown names are ignored rather than guessed at,
 * so a server that starts sending a new event cannot make the client replay
 * something it should not.
 */
export function classifySseEvent(event: string): SseEventClass | 'unknown' {
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so
  // 'toString' or 'constructor' would resolve to a function and break the
  // declared return type.
  if (Object.hasOwn(SSE_EVENT_CLASSES, event)) {
    return SSE_EVENT_CLASSES[event as SseEventName];
  }
  return 'unknown';
}

/**
 * Whether an event should be replayed when the user returns to the session
 * it belongs to.
 */
export function isReplayableEvent(event: string): boolean {
  return classifySseEvent(event) === 'replayable';
}
