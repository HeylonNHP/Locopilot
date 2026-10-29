import type { SseEventData } from '@/app/lib/sseRouting';

/**
 * The client's view of the turns it is streaming.
 *
 * This used to be five separate refs in the chat-stream hook — an owner map,
 * a buffer of events, a map of failed turns, a map of pending sub-agent text
 * and a shadow copy of the streaming-session set — and the rules for keeping
 * them in step (what happens when a new chat is assigned a real id, which
 * events belong to which turn, what is replayed when the user comes back)
 * were spread across the hook. Two shipped bug fixes came out of that.
 *
 * Here the state is one object and every rule is a pure function over it,
 * so the rules can be tested directly.
 */

/** An event held while the user is looking at another session. */
export interface BufferedEvent {
  event: string;
  data: SseEventData;
}

/** A turn the client is streaming. */
export interface StreamRequest {
  requestId: number;
  /** The session this turn belongs to; the placeholder until it is created. */
  sessionKey: number;
  /** Whether the turn failed, which keeps its retry payload alive. */
  failed: boolean;
}

/** Everything the client knows about its live turns. */
export interface StreamState {
  /** Live turns, by request id. */
  requests: Map<number, StreamRequest>;
  /** The live turn that owns each session key. */
  owners: Map<number, number>;
  /** Events held while the user was looking at another session. */
  buffers: Map<number, BufferedEvent[]>;
}

export function createStreamState(): StreamState {
  return {
    requests: new Map(),
    owners: new Map(),
    buffers: new Map(),
  };
}

/**
 * Register a turn that has just been sent.
 *
 * The turn claims its session key, and any events left over from an earlier
 * turn on the same session are dropped — they belong to a turn that is over.
 */
export function beginRequest(
  state: StreamState,
  requestId: number,
  sessionKey: number
): StreamState {
  const requests = new Map(state.requests);
  requests.set(requestId, { requestId, sessionKey, failed: false });
  const owners = new Map(state.owners);
  owners.set(sessionKey, requestId);
  const buffers = new Map(state.buffers);
  buffers.delete(sessionKey);
  return { requests, owners, buffers };
}

/**
 * Finish a turn. Returns the session key it owned so the caller can release
 * the session and drop whatever was buffered for it.
 */
export function endRequest(
  state: StreamState,
  requestId: number
): { state: StreamState; sessionKey: number | undefined } {
  const request = state.requests.get(requestId);
  const requests = new Map(state.requests);
  requests.delete(requestId);
  const owners = new Map(state.owners);
  if (request && owners.get(request.sessionKey) === requestId) {
    owners.delete(request.sessionKey);
  }
  return { state: { ...state, requests, owners }, sessionKey: request?.sessionKey };
}

/** Record that a turn failed, so its retry payload is preserved. */
export function markRequestFailed(state: StreamState, requestId: number): StreamState {
  const request = state.requests.get(requestId);
  if (!request) {
    return state;
  }
  const requests = new Map(state.requests);
  requests.set(requestId, { ...request, failed: true });
  return { ...state, requests };
}

/** Whether a turn failed. */
export function isRequestFailed(state: StreamState, requestId: number): boolean {
  return state.requests.get(requestId)?.failed === true;
}

/**
 * The session a turn belongs to, or `undefined` when the turn is unknown.
 */
export function ownerOf(state: StreamState, requestId: number): number | undefined {
  return state.requests.get(requestId)?.sessionKey;
}

/**
 * Re-point a turn at the session it was actually saved to.
 *
 * A brand-new chat is streamed under the placeholder key until the server
 * assigns a real id; when it does, every structure keyed by the placeholder
 * has to follow it. Doing this in one place is the point: the previous
 * implementation updated four structures in four loops, and missing one left
 * a turn attributed to a session that never existed.
 */
export function migrateSessionKey(state: StreamState, sessionId: number): StreamState {
  const requests = new Map<number, StreamRequest>();
  for (const [requestId, request] of state.requests) {
    requests.set(
      requestId,
      request.sessionKey === -1 ? { ...request, sessionKey: sessionId } : request
    );
  }

  const owners = new Map<number, number>();
  for (const [sessionKey, requestId] of state.owners) {
    owners.set(sessionKey === -1 ? sessionId : sessionKey, requestId);
  }

  const buffers = new Map<number, BufferedEvent[]>();
  for (const [sessionKey, events] of state.buffers) {
    const key = sessionKey === -1 ? sessionId : sessionKey;
    buffers.set(key, [...(buffers.get(key) ?? []), ...events]);
  }

  return { requests, owners, buffers };
}

/**
 * Hold an event because the session it belongs to is not the one on screen.
 */
export function bufferEvent(
  state: StreamState,
  sessionKey: number,
  event: string,
  data: SseEventData
): StreamState {
  const buffers = new Map(state.buffers);
  const buffered = buffers.get(sessionKey) ?? [];
  buffers.set(sessionKey, [...buffered, { event, data }]);
  return { ...state, buffers };
}

/**
 * Take the events held for a session, leaving nothing behind.
 */
export function takeBufferedEvents(
  state: StreamState,
  sessionKey: number
): { state: StreamState; events: BufferedEvent[] } {
  const buffered = state.buffers.get(sessionKey) ?? [];
  const buffers = new Map(state.buffers);
  buffers.delete(sessionKey);
  return { state: { ...state, buffers }, events: buffered };
}

/**
 * Drop the events held for a session.
 */
export function discardBufferedEvents(state: StreamState, sessionKey: number): StreamState {
  if (!state.buffers.has(sessionKey)) {
    return state;
  }
  const buffers = new Map(state.buffers);
  buffers.delete(sessionKey);
  return { ...state, buffers };
}

/**
 * The buffered terminal event for a session, if one was held.
 *
 * The `done` event is the only carrier of the end-of-turn token stats, so a
 * session whose turn finished while the user was away needs it applied
 * before the buffer is dropped.
 */
export function findBufferedDone(
  state: StreamState,
  sessionKey: number
): BufferedEvent | undefined {
  const buffered = state.buffers.get(sessionKey) ?? [];
  return [...buffered].reverse().find(({ event }) => event === 'done');
}
