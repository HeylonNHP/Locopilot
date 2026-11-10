/**
 * The client's view of the turns it is streaming.
 *
 * This used to be five separate refs in the chat-stream hook — an owner map,
 * a buffer of events, a map of failed turns, a map of pending sub-agent text
 * and a shadow copy of the streaming-session set — and the rules for keeping
 * them in step were spread across the hook. Two shipped bug fixes came out of
 * that.
 *
 * Here the state is one object and every rule is a pure function over it,
 * so the rules can be tested directly.
 *
 * It no longer holds events back while the user looks at another session.
 * That buffer was replayed on top of a fresh database copy when the user came
 * back, and the database already had part of what it held — so the replay
 * duplicated text, dropped what streamed in during the reload, and never
 * showed the tool call that was still running. Every event is now applied to
 * its own session as it arrives (the store keeps a slot per session), so the
 * session the user comes back to is already up to date.
 */

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
  /**
   * Live turns, by request id.
   *
   * This is the only ownership record: a turn's session is read from here
   * (`ownerOf`), so there is no second map to keep in step. The set of
   * streaming sessions lives in the store, which is what the UI reads.
   */
  requests: Map<number, StreamRequest>;
}

export function createStreamState(): StreamState {
  return { requests: new Map() };
}

/** Register a turn that has just been sent, claiming its session key. */
export function beginRequest(
  state: StreamState,
  requestId: number,
  sessionKey: number
): StreamState {
  const requests = new Map(state.requests);
  requests.set(requestId, { requestId, sessionKey, failed: false });
  return { requests };
}

/**
 * Finish a turn. Returns the session key it owned so the caller can release
 * the session, and whether the turn failed.
 *
 * The failure flag lives on the request record, so it disappears with the
 * record. Callers that need it must read it from here — reading it back out
 * of the state afterwards always says "did not fail", which silently
 * discards the turn's retry payload.
 */
export function endRequest(
  state: StreamState,
  requestId: number
): { state: StreamState; sessionKey: number | undefined; failed: boolean } {
  const request = state.requests.get(requestId);
  const requests = new Map(state.requests);
  requests.delete(requestId);
  return {
    state: { requests },
    sessionKey: request?.sessionKey,
    failed: isRequestFailed(state, requestId),
  };
}

/** Record that a turn failed, so its retry payload is preserved. */
export function markRequestFailed(state: StreamState, requestId: number): StreamState {
  const request = state.requests.get(requestId);
  if (!request) {
    return state;
  }
  const requests = new Map(state.requests);
  requests.set(requestId, { ...request, failed: true });
  return { requests };
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
 * assigns a real id; when it does, the turn has to follow it.
 */
export function migrateSessionKey(state: StreamState, sessionId: number): StreamState {
  const requests = new Map<number, StreamRequest>();
  for (const [requestId, request] of state.requests) {
    requests.set(
      requestId,
      request.sessionKey === -1 ? { ...request, sessionKey: sessionId } : request
    );
  }
  return { requests };
}
