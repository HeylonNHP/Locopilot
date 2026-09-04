/**
 * Client helper for hot-swapping the model of a turn that is already
 * streaming. Picking a model always updates config for future turns; this
 * additionally asks the in-flight turn to switch at its next tool-call
 * boundary.
 *
 * Returns true when the server accepted the switch (a `model_switched`
 * status event will follow), false when there was no streaming turn to
 * switch or the request failed — in which case the config update the caller
 * already made is the whole story.
 */

export interface MidTurnModelSwitch {
  model?: string;
  providerId?: string;
  /** Empty string is meaningful: "same as the main model". */
  compactionModel?: string;
  compactionProviderId?: string;
}

export async function requestMidTurnModelSwitch(
  sessionId: number,
  payload: MidTurnModelSwitch,
  /**
   * Abort signal from the chat stream that the switch is targeting. When
   * the user clicks Stop while this fetch is in flight the fetch is
   * cancelled client-side, the server-side `pendingSwitches[sessionId]`
   * entry is cleaned up by the route's `unregisterActiveTurn`, and the
   * UI's `modelSwitchPending` flag is reset — so the switch is dropped
   * cleanly rather than landing on a non-streaming session.
   */
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const response = await fetch('/api/chat/switch-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...payload }),
      ...(signal ? { signal } : {}),
    });
    return response.ok;
  } catch {
    // AbortError lands here too — surface as `false` so the caller can
    // reset `modelSwitchPending` consistently with network failures.
    return false;
  }
}
