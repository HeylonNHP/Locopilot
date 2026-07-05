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

export function parseNonNegativeInteger(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER
): number | null {
  return parsePositiveInteger(value, 0, max);
}

export function parsePositiveTimeoutMs(seconds: unknown): number | null {
  const parsedSeconds = parseFiniteNumber(seconds);
  if (parsedSeconds === null || parsedSeconds <= 0) return null;
  const ms = Math.floor(parsedSeconds * 1000);
  if (!Number.isFinite(ms) || ms < 1) return null;
  return Math.min(ms, 3_600_000);
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
