'use client';

import type { SessionDefaultsPatch, SessionSelectionPatch } from '@/services/sessionSelection';

import { readErrorMessage } from '@/app/lib/switchModelClient';

/**
 * What a save achieved.
 *
 * A failure carries the server's own words when it said any: the server
 * writes a message that names the cause (ground rule 3 of the provider-pair
 * work: "a pair that cannot be honoured is refused with a message that names
 * the cause"), and a bare boolean threw it away, so every refusal reached the
 * user as the same generic sentence. `message` is `null` when there is
 * nothing to add - the request never got an answer, or the answer had no
 * body.
 */
export type SaveResult = { ok: true } | { ok: false; message: string | null };

const SAVED: SaveResult = { ok: true };

/**
 * `fallback` with the server's cause appended, or `fallback` alone when the
 * server said nothing.
 *
 * The error banner shows the FIRST line as its headline, so the cause goes in
 * the first line, after the generic sentence.
 */
export function saveFailureMessage(fallback: string, result: SaveResult): string {
  if (result.ok || result.message === null) return fallback;
  return `${fallback.replace(/\.$/, '')}: ${result.message}`;
}

/** The failure for a response the server refused. */
async function refused(res: Response): Promise<SaveResult> {
  return { ok: false, message: await readErrorMessage(res) };
}

/**
 * The body that writes the global defaults - what a NEW conversation starts
 * with - to `config.json`.
 *
 * Only the keys the caller actually changed are sent: `PUT /api/config`
 * merges, so a reasoning pick must not re-write the default model another
 * tab may have just changed. A null provider id means "not pinned" and is
 * omitted, as before.
 *
 * The compaction PROVIDER is the exception: a null there means "clear the
 * global compaction provider" - the compaction then runs on the main chat
 * provider - so it is sent rather than omitted. Omitting it would leave a
 * stale provider behind, and the global compaction model would keep going to
 * the endpoint it was cleared for.
 */
function defaultsBody(patch: SessionDefaultsPatch): Record<string, unknown> {
  return {
    ...(patch.model === undefined ? {} : { model: patch.model }),
    ...(patch.providerId === null || patch.providerId === undefined
      ? {}
      : { activeProviderId: patch.providerId }),
    ...(patch.compactionModel === undefined ? {} : { compactionModel: patch.compactionModel }),
    ...(patch.compactionProviderId === undefined
      ? {}
      : { compactionProviderId: patch.compactionProviderId }),
    ...(patch.reasoningEffort === undefined ? {} : { reasoningEffort: patch.reasoningEffort }),
    ...(patch.compactionReasoningEffort === undefined
      ? {}
      : { compactionReasoningEffort: patch.compactionReasoningEffort }),
  };
}

/**
 * Save a field-preserving change to the global defaults.
 *
 * Reports the server's refusal instead of swallowing it. The defaults are
 * what a new conversation starts with; the conversation on screen is
 * unaffected.
 */
export async function saveDefaultsPatch(patch: SessionDefaultsPatch): Promise<SaveResult> {
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(defaultsBody(patch)),
    });
    return res.ok ? SAVED : await refused(res);
  } catch {
    return { ok: false, message: null };
  }
}

/**
 * Save a field-preserving change to a conversation's selection.
 *
 * A new chat has no row yet: there is nothing to write, and the values become
 * part of the `POST /api/sessions` body that creates it.
 *
 * Reports why the row could not be written. The caller puts the old
 * selection back / reports the failure: a selection the server does not know
 * about is a selection that is lost on the next reload.
 */
export async function saveSessionPatch(
  sessionId: number | null,
  patch: SessionSelectionPatch
): Promise<SaveResult> {
  if (sessionId === null) return SAVED;
  try {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return res.ok ? SAVED : await refused(res);
  } catch {
    return { ok: false, message: null };
  }
}

/**
 * Save a selection change and the defaults that follow it.
 *
 * Two writes, because the change lives in two places: the conversation's own
 * row (so it keeps the value when opened again) and the global defaults (so
 * the next new conversation starts with it). Each write carries only the
 * fields the control edited.
 *
 * The conversation's row is written first, because it is the one that
 * matters: a global default that failed to save costs the user the value of
 * their next new conversation, while a row that failed to save would lose the
 * value of the conversation they are in.
 *
 * Fails when EITHER write failed. The caller must not dispatch the
 * new values as saved in that case — in particular, a defaults write that
 * failed must not be shown as the new default.
 */
export async function saveSelectionChanges(
  sessionId: number | null,
  selectionPatch: SessionSelectionPatch,
  defaultsPatch: SessionDefaultsPatch
): Promise<SaveResult> {
  const sessionSaved = await saveSessionPatch(sessionId, selectionPatch);
  if (!sessionSaved.ok) return sessionSaved;
  return saveDefaultsPatch(defaultsPatch);
}
