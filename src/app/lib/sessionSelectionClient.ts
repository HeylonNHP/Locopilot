'use client';

import type { SessionDefaults, SessionSelection } from '@/services/sessionSelection';

/**
 * The body that writes the global defaults - what a NEW conversation starts
 * with - to `config.json`.
 *
 * The defaults are written, not a conversation's selection: a pick of the
 * main model must not move the default compaction model, and a pick of the
 * compaction model must not move the default main model.
 */
function defaultsBody(defaults: SessionDefaults): Record<string, unknown> {
  return {
    model: defaults.model,
    // A null provider id means "not pinned": the config keeps the id it
    // has, and the reconciler re-derives one from the model.
    ...(defaults.providerId === null ? {} : { activeProviderId: defaults.providerId }),
    compactionModel: defaults.compactionModel,
  };
}

/**
 * Save the global defaults alone.
 *
 * Used when there is no conversation to pin: a new-chat view, or a
 * conversation whose model is not set.
 */
export async function saveSessionDefaults(defaults: SessionDefaults): Promise<void> {
  try {
    await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(defaultsBody(defaults)),
    });
  } catch {
    // The defaults are what a new conversation starts with; the conversation
    // on screen is unaffected.
  }
}

/**
 * Save the model selection of the conversation on screen.
 *
 * Two writes, because the selection lives in two places: the conversation's
 * own row, so the conversation keeps this model when it is opened again, and
 * the global defaults, so the next new conversation starts on it.
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
  selection: SessionSelection,
  defaults: SessionDefaults
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

  await saveSessionDefaults(defaults);
  return true;
}
