/**
 * tpsDisplay.ts
 *
 * Display policy for the status bar's tokens-per-second read-out. Keeping
 * the precedence rules in one tested place stops the badge from ever
 * presenting prompt-processing speed as generation speed (a prompt-processing
 * rate routinely runs 5-50x generation speed) or showing garbage values.
 *
 * Precedence:
 * 1. `currentTps` — the live rough estimate streamed via `status` events
 *    while the LLM is generating. Presented without a caveat tag: it is
 *    inherently a live figure and only exists while streaming.
 * 2. `tokenStats.evalTps` — the authoritative end-of-turn figure (Ollama
 *    eval_duration-based), or the wall-clock fallback for providers that do
 *    not report durations. Wall-clock-derived figures carry
 *    `evalTpsEstimated` and are tagged "(est)".
 * 3. Nothing. `tokenStats.promptTps` is deliberately NOT used as a
 *    fallback: it measures prompt processing, not generation, and rendering
 *    it as "t/s" badly misleads.
 */

/** The fields of the store's tokenStats that the t/s display consumes. */
export interface TpsStatsSource {
  evalTps?: number | null;
  evalTpsEstimated?: boolean;
  promptTps?: number | null;
}

export interface TpsDisplay {
  value: number;
  isEstimated: boolean;
  label: string;
}

/**
 * Resolve what the status bar should display for tokens-per-second, or null
 * when nothing trustworthy is available (no live value, no end-of-turn
 * generation rate, or a non-positive/non-finite number).
 */
export function resolveTpsDisplay(
  currentTps: number | null | undefined,
  tokenStats: TpsStatsSource | null | undefined
): TpsDisplay | null {
  const fromLive = typeof currentTps === 'number' && currentTps > 0;
  const value = fromLive ? currentTps : (tokenStats?.evalTps ?? null);
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  // Only the end-of-turn wall-clock fallback is tagged; the live figure is
  // implicitly understood to be a transient estimate.
  const isEstimated = !fromLive && (tokenStats?.evalTpsEstimated ?? false);
  return {
    value,
    isEstimated,
    label: `${value.toFixed(2)} t/s${isEstimated ? ' (est)' : ''}`,
  };
}