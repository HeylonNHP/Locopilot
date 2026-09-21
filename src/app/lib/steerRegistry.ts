/**
 * Server-side pending steering-message registry.
 *
 * Mirrors `modelSwitchRegistry.ts`'s side-channel shape: `/api/chat/steer`
 * writes a pending entry here, and the in-flight chat route (and, when the
 * message targets a running sub-agent, the sub-agent loop) consumes it at
 * the top of the next tool-call loop iteration — the same boundary a model
 * switch lands at.
 *
 * Two differences from the model-switch registry:
 *  - This is a FIFO QUEUE per session, not a single merge-on-write object.
 *    A user can type several steering messages before either loop reaches
 *    its next boundary, and none of them may be silently dropped or
 *    overwritten.
 *  - Entries carry a `target` ('main' or 'subagent') so a drain can be
 *    scoped to whichever loop is asking, without one loop stealing a
 *    message meant for the other.
 *
 * Mirrors the singleton-state caveat of `approvalRegistry.ts` /
 * `modelSwitchRegistry.ts`: this only works in a single-process deployment,
 * which is what Locopilot is.
 */

import { hasActiveTurn } from '@/app/lib/modelSwitchRegistry';

export interface SteerMessage {
  id: string;
  text: string;
  target: 'main' | 'subagent';
  /**
   * When `target` is 'subagent', the specific sub-agent id the client had
   * in view when it sent the message (from the `subagent_output`/
   * `subagent_chunk` events it already receives). Undefined means "whichever
   * sub-agent is currently running" — left as-is by a drain for a
   * non-matching agent so it can be picked up once the right agent runs.
   */
  agentId?: string;
  queuedAt: number;
}

/** Pending steering messages, keyed by session ID, oldest first. */
const pendingSteers = new Map<number, SteerMessage[]>();

let nextSeq = 0;
function generateId(): string {
  nextSeq += 1;
  return `steer_${Date.now()}_${nextSeq}`;
}

/**
 * Queue a steering message for a session.
 *
 * Returns the new entry's id, or `false` when the session has no streaming
 * turn — the caller (the API route) surfaces that as a 404 so the client
 * knows to keep the text in the composer rather than treat it as sent.
 */
export function requestSteerMessage(
  sessionId: number,
  text: string,
  target: 'main' | 'subagent',
  agentId?: string
): string | false {
  if (!hasActiveTurn(sessionId)) return false;
  const id = generateId();
  const entry: SteerMessage = {
    id,
    text,
    target,
    queuedAt: Date.now(),
    ...(agentId === undefined ? {} : { agentId }),
  };
  const queue = pendingSteers.get(sessionId);
  if (queue) {
    queue.push(entry);
  } else {
    pendingSteers.set(sessionId, [entry]);
  }
  return id;
}

/**
 * Drain queued messages for a session that match `target` (and, for
 * 'subagent', either have no pinned `agentId` or match `agentId`). Matching
 * entries are removed; non-matching entries are left queued for a later
 * drain (e.g. a 'subagent'-targeted message pinned to a different agent, or
 * a 'main'-targeted message while this call is draining 'subagent').
 */
export function drainSteerMessages(
  sessionId: number,
  target: 'main' | 'subagent',
  agentId?: string
): SteerMessage[] {
  const queue = pendingSteers.get(sessionId);
  if (!queue || queue.length === 0) return [];

  const drained: SteerMessage[] = [];
  const remaining: SteerMessage[] = [];
  for (const entry of queue) {
    const matches =
      entry.target === target &&
      (target === 'main' || !entry.agentId || !agentId || entry.agentId === agentId);
    if (matches) {
      drained.push(entry);
    } else {
      remaining.push(entry);
    }
  }

  if (remaining.length > 0) {
    pendingSteers.set(sessionId, remaining);
  } else {
    pendingSteers.delete(sessionId);
  }
  return drained;
}

/**
 * Remove and return every entry still queued for a session, regardless of
 * target. Used as a turn-end salvage so a steering message that never found
 * a loop iteration to land in (e.g. the sub-agent it was pinned to never
 * ran again before the turn ended) is still folded into the transcript
 * instead of silently vanishing.
 */
export function clearSteerMessages(sessionId: number): SteerMessage[] {
  const queue = pendingSteers.get(sessionId);
  pendingSteers.delete(sessionId);
  return queue ?? [];
}
