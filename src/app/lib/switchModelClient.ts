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
  payload: MidTurnModelSwitch
): Promise<boolean> {
  try {
    const response = await fetch('/api/chat/switch-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...payload }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
