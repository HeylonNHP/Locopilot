import type { CompactionSelection } from '@/services/sessionSelection';

/**
 * Client helper for hot-swapping the model of a turn that is already
 * streaming. Picking a model always updates config for future turns; this
 * additionally asks the in-flight turn to switch at its next tool-call
 * boundary.
 *
 * The helper REPORTS what the server said. A refusal is a message the user
 * has to see: the branch's rule is "loud beats silent", and the old
 * `Promise<boolean>` threw the server's message away, so a refused switch
 * looked exactly like a successful one.
 */

export interface MidTurnModelSwitch {
  model?: string;
  providerId?: string;
  /**
   * The new compaction selection — ONE value, so a compaction model can
   * never be switched to without the provider that serves it. Absent leaves
   * the current selection alone.
   */
  compaction?: CompactionSelection;
}

/**
 * What a mid-turn switch request achieved.
 *
 * `accepted` is the old boolean, renamed for what it means: the server took
 * the request, and the running turn will apply it at its next tool step (or
 * refuse it, and say so over the stream). `message` is what the user has to
 * be told — the server's own words when it refused, and `null` when there is
 * nothing to report.
 */
export interface MidTurnSwitchResult {
  accepted: boolean;
  message: string | null;
}

/**
 * The mid-turn switch payload for the parts that changed.
 *
 * ONE builder for both callers, so the payload can never be empty by
 * accident: the route refuses an empty body with HTTP 400 ("At least one of
 * \"model\", \"compaction\", or \"providerId\" is required"), and that refusal
 * used to be thrown away by the client.
 *
 * An absent part means "this half did not change" and is left out; the
 * compaction selection is ONE value, so it is carried whole or not at all.
 */
export function buildMidTurnSwitch(parts: {
  model?: string | null | undefined;
  providerId?: string | null | undefined;
  compaction?: CompactionSelection | undefined;
}): MidTurnModelSwitch {
  const payload: MidTurnModelSwitch = {};
  const model = typeof parts.model === 'string' ? parts.model.trim() : '';
  if (model !== '') payload.model = model;
  const providerId = typeof parts.providerId === 'string' ? parts.providerId.trim() : '';
  if (providerId !== '') payload.providerId = providerId;
  if (parts.compaction !== undefined) payload.compaction = parts.compaction;
  return payload;
}

/**
 * Whether a switch payload says anything at all.
 *
 * An empty payload is a request the server refuses, so nothing is sent:
 * there is no switch to make and no refusal to report.
 */
export function isEmptyMidTurnSwitch(payload: MidTurnModelSwitch): boolean {
  return (
    payload.model === undefined &&
    payload.providerId === undefined &&
    payload.compaction === undefined
  );
}

/**
 * The message shown when a switch did not happen.
 *
 * `headline` says what happened; `reason` is the server's own words, which
 * name the cause (ground rule 3: "a pair that cannot be honoured is refused
 * with a message that names the cause"). The second line says what the
 * failure MEANS: the running turn kept the model and the compaction it had,
 * and the selection that WAS saved applies from the next turn.
 */
export function switchFailureMessage(headline: string, reason: string | null | undefined): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  const first = trimmed === '' ? `${headline}.` : `${headline}: ${trimmed}`;
  return `${first}\nThe running turn keeps the model and the compaction it has. The new selection applies from the next turn.`;
}

/**
 * The message in a refused response body.
 *
 * The body is the only place the refusal is written down, so it is read
 * here rather than thrown away. The shape matches the one the Settings
 * modal already uses for its own config write: the JSON `error` field when
 * there is one, the raw text otherwise.
 */
export async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (text.trim() === '') return null;
    try {
      const payload = JSON.parse(text) as { error?: unknown };
      if (typeof payload.error === 'string') {
        const trimmed = payload.error.trim();
        // A blank `error` is no error at all - showing the raw JSON body
        // instead would put `{"error":"  "}` in the banner.
        return trimmed === '' ? null : trimmed;
      }
    } catch {
      // Not JSON - the raw text is the message.
    }
    return text.trim();
  } catch {
    return null;
  }
}

export async function requestMidTurnModelSwitch(
  sessionId: number,
  payload: MidTurnModelSwitch,
  /**
   * Abort signal from the chat stream that the switch is targeting. When
   * the user clicks Stop while this fetch is in flight the fetch is
   * cancelled client-side, the server-side `pendingSwitches[sessionId]`
   * entry is cleaned up by the route's `unregisterActiveTurn`, and the
   * UI's model-switch-pending flag for that session is reset — so the switch is dropped
   * cleanly rather than landing on a non-streaming session.
   */
  signal?: AbortSignal
): Promise<MidTurnSwitchResult> {
  // Nothing to switch: the route would answer HTTP 400, and there is no
  // refusal to report because there was no request to make.
  if (isEmptyMidTurnSwitch(payload)) {
    return { accepted: false, message: null };
  }
  try {
    const response = await fetch('/api/chat/switch-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...payload }),
      ...(signal ? { signal } : {}),
    });
    if (response.ok) return { accepted: true, message: null };
    const reason = await readErrorMessage(response);
    if (response.status === 404) {
      // No turn is streaming for that session any more. The selection is
      // already saved, and the next turn runs on it — so there is nothing
      // to report.
      return { accepted: false, message: null };
    }
    return {
      accepted: false,
      message: switchFailureMessage('The model switch was refused', reason),
    };
  } catch {
    if (signal?.aborted) {
      // The user pressed Stop while the request was in flight. The turn is
      // over; the pending flag is reset and nothing is said.
      return { accepted: false, message: null };
    }
    return {
      accepted: false,
      message: switchFailureMessage(
        'The model switch could not be sent: the request to the server failed',
        null
      ),
    };
  }
}
