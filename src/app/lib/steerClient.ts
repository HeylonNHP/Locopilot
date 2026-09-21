/**
 * Client helper for sending a steering message to a turn that is already
 * streaming. The message is picked up at the next tool-call loop boundary
 * (main loop or the currently-running sub-agent's loop, per `target`) and
 * confirmed with a `steer_applied` status event.
 *
 * Returns the queued message's id when the server accepted it, or `null`
 * when there was no streaming turn to steer or the request failed — in
 * which case the caller must keep the text in the composer rather than
 * treat it as sent.
 */

export interface SteerRequestPayload {
  text: string;
  target: 'main' | 'subagent';
  agentId?: string;
}

export async function requestSteerMessage(
  sessionId: number,
  payload: SteerRequestPayload,
  /**
   * Abort signal from the chat stream the steer is targeting. When the
   * user clicks Stop while this fetch is in flight, the fetch is cancelled
   * client-side and the caller's ack-wait logic times out the same way it
   * would for a 404 — the composer keeps the text.
   */
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const response = await fetch('/api/chat/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...payload }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { ok: boolean; id?: string };
    return data.id ?? null;
  } catch {
    // AbortError lands here too.
    return null;
  }
}
