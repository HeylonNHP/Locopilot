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

import type { CompactionSelection } from '@/services/sessionSelection';

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
   * The new compaction selection — ONE value, so a compaction model can
   * never be switched to without the provider that serves it.
   *
   * Absent leaves the current selection alone. A value replaces it whole:
   * `{kind:'same-as-main'}` is "the main model, on the main provider" and
   * `{kind:'explicit', model, providerId}` is a named model on a named
   * provider.
   */
  compaction?: CompactionSelection;
}

type SwitchField = keyof ModelSwitchRequest;
const SWITCH_FIELDS: readonly SwitchField[] = ['model', 'providerId', 'compaction'];

/**
 * Which request last wrote each field of a pending entry. A field is
 * "answered" when the caller that peeked it acknowledges it, and a later
 * request that rewrote the field has a newer stamp, so it is NOT answered
 * and must survive the acknowledgement.
 */
type FieldStamps = Partial<Record<SwitchField, number>>;

interface PendingSwitch {
  request: ModelSwitchRequest;
  stamps: FieldStamps;
}

/** Pending switches, keyed by session ID. At most one per session. */
const pendingSwitches = new Map<number, PendingSwitch>();

/** The stamps each peeked snapshot was taken at, for `acknowledgeModelSwitch`. */
const peekedStamps = new WeakMap<ModelSwitchRequest, FieldStamps>();

let nextStamp = 1;

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
  const entry: PendingSwitch = {
    request: { ...existing?.request },
    stamps: { ...existing?.stamps },
  };
  const stamp = nextStamp++;
  for (const field of SWITCH_FIELDS) {
    // An absent field leaves the pending value alone, as documented.
    if (request[field] === undefined) continue;
    Object.assign(entry.request, { [field]: request[field] });
    entry.stamps[field] = stamp;
  }
  pendingSwitches.set(sessionId, entry);
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
  const entry = pendingSwitches.get(sessionId);
  if (!entry) return null;
  // A snapshot, not the stored object: the caller works on it across awaits
  // while a newer request may merge into the entry.
  const snapshot: ModelSwitchRequest = { ...entry.request };
  peekedStamps.set(snapshot, { ...entry.stamps });
  return snapshot;
}

/**
 * Drop the pending switch for a session. Call this only after a successful
 * `peekModelSwitch` + apply — i.e. once the new models have been written
 * to the request context.
 *
 * `peeked` is the exact object the caller received from `peekModelSwitch`.
 * A new `requestModelSwitch` can merge into the entry between our peek and
 * acknowledge (`applyPendingModelSwitch` awaits a config read and the model
 * probes in between). Only the fields the caller actually peeked are
 * dropped: a field a newer request wrote has a newer stamp and stays, so it
 * is answered by a later iteration. Dropping the whole entry would lose that
 * newer request; keeping the whole entry would answer the old fields again,
 * and a switch that was refused would drag the newer one down with it
 * (bug hunt A14).
 *
 * Returns `true` when nothing is left pending, `false` when a newer request
 * wrote a field after the peek (it stays pending).
 */
export function acknowledgeModelSwitch(sessionId: number, peeked: ModelSwitchRequest): boolean {
  const entry = pendingSwitches.get(sessionId);
  if (!entry) return true;
  const peekedAt = peekedStamps.get(peeked);
  // An object this registry did not hand out answers nothing.
  if (!peekedAt) return false;
  for (const field of SWITCH_FIELDS) {
    if (entry.stamps[field] !== peekedAt[field]) continue;
     
    delete entry.request[field];
    delete entry.stamps[field];
  }
  if (SWITCH_FIELDS.some((field) => entry.request[field] !== undefined)) return false;
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
  return pending.request;
}

/**
 * Whether a session currently has a streaming turn. Shared with
 * `steerRegistry.ts` so steering-message requests are gated on the same
 * turn-liveness tracking as model switches, instead of keeping a second
 * `Set` in sync.
 */
export function hasActiveTurn(sessionId: number): boolean {
  return activeTurns.has(sessionId);
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
