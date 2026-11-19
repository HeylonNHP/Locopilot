/**
 * Shared argument-parsing helpers for tool command handlers.
 */

export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) ? value : null;
}

export function parsePositiveInteger(
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
): number | null {
  const parsed = parseFiniteNumber(value);
  if (parsed === null) return null;
  const floored = Math.floor(parsed);
  if (floored < min || floored > max) return null;
  return floored;
}

/**
 * The longest wait the runtime can hold: `setTimeout` fires at once, with a
 * warning, for a delay above 2^31 - 1 ms (about 24.8 days). It is the only
 * ceiling on a timeout, and a value above it is REFUSED, never shortened.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** The same ceiling in whole seconds, for messages and descriptions. */
export const MAX_TIMEOUT_SECONDS = Math.floor(MAX_TIMEOUT_MS / 1000);

/**
 * Seconds -> milliseconds for a wait, or null when `seconds` is not a
 * positive finite number of at most {@link MAX_TIMEOUT_SECONDS}.
 */
export function parsePositiveTimeoutMs(seconds: unknown): number | null {
  const parsedSeconds = parseFiniteNumber(seconds);
  if (parsedSeconds === null || parsedSeconds <= 0) return null;
  const ms = Math.floor(parsedSeconds * 1000);
  if (!Number.isFinite(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) return null;
  return ms;
}

export function parseQueriesInput(raw: unknown): string[] {
  const splitAndNormalize = (value: string): string[] => {
    return value
      .split(/[\n,;]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  };

  if (Array.isArray(raw)) {
    return raw
      .flatMap((item) => String(item).split(/[\n,;]/))
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith('[')) {
      return splitAndNormalize(trimmed);
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter((item) => item.length > 0);
      }
    } catch {
      return splitAndNormalize(trimmed);
    }

    return splitAndNormalize(trimmed);
  }

  return [];
}

/**
 * Milliseconds -> the wait `run_command` uses, or null when `value` is not a
 * positive finite number of at most {@link MAX_TIMEOUT_MS}.
 * `timeout_ms` is always milliseconds; there is no unit guessing.
 */
export function parsePositiveTimeoutMsFromMs(value: unknown): number | null {
  const parsed = parseFiniteNumber(value);
  if (parsed === null || parsed <= 0) return null;
  const ms = Math.floor(parsed);
  if (ms < 1 || ms > MAX_TIMEOUT_MS) return null;
  return ms;
}
