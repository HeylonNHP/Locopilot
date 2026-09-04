/**
 * Server-side pending model-switch registry.
 *
 * SSE is server→client only, so a turn that is already streaming has no
 * inbound channel to learn that the user picked a different model. This
 * registry is the side channel: `/api/chat/switch-model` writes a pending
 * switch here, and the in-flight chat route consumes it at the top of each
 * tool-call loop iteration — i.e. the switch lands at the next natural
 * boundary, never mid-stream.
 *
 * Mirrors the singleton-state caveat of `approvalRegistry.ts`: this only
 * works in a single-process deployment, which is what Locopilot is.
 */

/**
 * A requested change to the models an in-flight turn is using. Every field
 * is optional so the main model and the compaction model can be switched
 * independently.
 */
export interface ModelSwitchRequest {
  /** New main model. Also becomes the sub-agent model. */
  model?: string;
  /** Provider ID for the new main model, when the client knows it. */
  providerId?: string;
  /**
   * New compaction model. An empty string is meaningful and means "same as
   * the main model" — the same convention `resolveCompactionModel` already
   * uses for the request body's `compactionModel` field.
   */
  compactionModel?: string;
  /** Provider ID for the new compaction model, when the client knows it. */
  compactionProviderId?: string;
}

/** Pending switches, keyed by session ID. At most one per session. */
const pendingSwitches = new Map<number, ModelSwitchRequest>();

/** Request IDs of the turns currently streaming, keyed by session ID. */
const activeTurns = new Map<number, Set<string>>();

/**
 * Record a requested model switch for a session. Merges into any switch
 * that has not been consumed yet, so a main-model switch followed closely
 * by a compaction-model switch does not clobber the first.
 *
 * Returns `false` when the session has no streaming turn — the caller
 * should treat that as "nothing to switch, the next turn will carry the new
 * model in its request body anyway".
 */
export function requestModelSwitch(sessionId: number, request: ModelSwitchRequest): boolean {
  if (!activeTurns.has(sessionId)) return false;
  const existing = pendingSwitches.get(sessionId);
  pendingSwitches.set(sessionId, { ...existing, ...request });
  return true;
}

/**
 * Read the pending switch for a session WITHOUT removing it.
 *
 * Both the main tool-call loop and any in-flight sub-agent batch poll for
 * the same entry; whichever reads it first applies the change and calls
 * `acknowledgeModelSwitch` to drop it. The other polls, sees an empty
 * result, and no-ops. This is what keeps a switch from being silently
 * consumed by a sub-agent while the main loop is parked on the batch.
 */
export function peekModelSwitch(sessionId: number): ModelSwitchRequest | null {
  return pendingSwitches.get(sessionId) ?? null;
}

/**
 * Drop the pending switch for a session. Call this only after a successful
 * `peekModelSwitch` + apply — i.e. once the new models have been written
 * to the request context.
 *
 * `peeked` is the exact object the caller received from `peekModelSwitch`.
 * It guards against the race where a new `requestModelSwitch` merges
 * into the entry between our peek and acknowledge (which can happen if
 * `applyPendingModelSwitch` awaits on something — e.g. a numCtx probe —
 * between the two calls). In that case we refuse to drop the entry so a
 * later iteration picks up the merged request instead of losing it.
 *
 * Returns `true` when the entry was removed, `false` when a newer
 * request has since merged into it.
 */
export function acknowledgeModelSwitch(
  sessionId: number,
  peeked: ModelSwitchRequest
): boolean {
  const current = pendingSwitches.get(sessionId);
  if (current !== peeked) return false;
  pendingSwitches.delete(sessionId);
  return true;
}

/**
 * @deprecated Destructive read: removes the entry on read. If two callers
 * peek at the same session (main loop + sub-agent batch), whichever calls
 * this first wins and the other silently sees `null` — exactly the bug
 * this registry was rewritten to avoid. Use `peekModelSwitch` + an
 * explicit `acknowledgeModelSwitch` after a successful apply instead.
 */
export function consumeModelSwitch(sessionId: number): ModelSwitchRequest | null {
  const pending = pendingSwitches.get(sessionId);
  if (!pending) return null;
  pendingSwitches.delete(sessionId);
  return pending;
}

/** Mark a turn as streaming so switches for its session are accepted. */
export function registerActiveTurn(sessionId: number, requestId: string): void {
  const turns = activeTurns.get(sessionId);
  if (turns) {
    turns.add(requestId);
    return;
  }
  activeTurns.set(sessionId, new Set([requestId]));
}

/**
 * Mark a turn as finished. Once a session has no streaming turns left, any
 * unconsumed switch is dropped so it cannot leak into a later, unrelated
 * turn on the same session.
 */
export function unregisterActiveTurn(sessionId: number, requestId: string): void {
  const turns = activeTurns.get(sessionId);
  if (!turns) return;
  turns.delete(requestId);
  if (turns.size > 0) return;
  activeTurns.delete(sessionId);
  pendingSwitches.delete(sessionId);
}
