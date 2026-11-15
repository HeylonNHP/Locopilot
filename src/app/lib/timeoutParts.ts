/**
 * Converts hours / minutes / seconds text-input values into milliseconds.
 *
 * Each part is clamped to zero or more before summing, so a negative part
 * cannot cancel out another (hours -1 with minutes 90 is 90 minutes, not 30).
 * Unparseable or empty parts count as zero. The result is not bounded here;
 * the server enforces the upper limit.
 */
export function timeoutPartsToMs(hours: string, minutes: string, seconds: string): number {
  const part = (raw: string): number => Math.max(0, Number.parseInt(raw, 10) || 0);
  return (part(hours) * 3600 + part(minutes) * 60 + part(seconds)) * 1000;
}
