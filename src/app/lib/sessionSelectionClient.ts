'use client';

import type { SessionSelection } from '@/services/sessionSelection';

/**
 * Save the model selection of the conversation on screen.
 *
 * Two writes, because the selection lives in two places: the conversation's
 * own row, so the conversation keeps this model when it is opened again, and
 * the global default, so the next new conversation starts on it.
 *
 * The conversation's row is written first, because it is the one that
 * matters: a global default that failed to save costs the user the model of
 * their next new conversation, while a row that failed to save would lose
 * the model of the conversation they are in.
 *
 * Returns false when the conversation's row could not be written. The caller
 * puts the old selection back: a selection the server does not know about is
 * a selection that is lost on the next reload.
 */
export async function saveSessionSelection(
  sessionId: number | null,
  selection: SessionSelection
): Promise<boolean> {
  try {
    if (sessionId !== null) {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selection),
      });
      if (!res.ok) return false;
    }
  } catch {
    return false;
  }

  try {
    await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selection.model,
        activeProviderId: selection.providerId,
        // A conversation that inherits the global compaction model does not
        // change it: writing the empty string here would turn "inherit" into
        // "compact with the main model" for every conversation.
        ...(selection.compactionModel === null
          ? {}
          : { compactionModel: selection.compactionModel }),
      }),
    });
  } catch {
    // The conversation's own selection is saved; only the default a new
    // conversation starts with is stale.
  }

  return true;
}
