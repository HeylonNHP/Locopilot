/**
 * What the UI shows about the context window — and nothing it works out itself.
 *
 * The SERVER decides the window: the user's setting (the provider's own, else
 * the global one) capped by the model's maximum when that is known
 * (`src/services/contextWindow/resolveNumCtx.ts`). The page asks
 * `GET /api/numctx` for it, receives it with every chat turn, and displays
 * what it is told. It never computes a minimum and never invents a stand-in:
 * the client used to keep one (`DEFAULT_NUM_CTX`, 131 072) for "the config has
 * not loaded yet", and it leaked — a reloaded session showed
 * "276922/131072 tokens (211%)" for a model that supports 1 000 000.
 *
 * "The server has not answered yet" is therefore a first-class state here —
 * `null` — and every consumer decides what to show for it ("—").
 * Everything in this module is pure so the rules are pinned by
 * tests/context-window.test.mjs.
 */

/**
 * A positive safe integer, or `null` for anything else (0, negatives, NaN,
 * fractions, strings, `undefined`). The one definition of "a usable window
 * size" on the client; it matches what `PUT /api/config` accepts.
 */
export function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** What the server reported for the selected model. */
export interface ServerWindow {
  /** The window the server will use. Absent or `null` until it has answered. */
  effective?: number | null | undefined;
  /** The model's maximum as the server reported it; `null` when it does not know. */
  modelMax?: number | null | undefined;
}

export interface ContextWindowView {
  /** The window to show and to compute percentages against; `null` until the server has answered. */
  limit: number | null;
  /** The model's maximum, set when it is what limits the window (the window equals it). */
  cappedAt: number | null;
  /** True when the server answered but does not know the model's maximum. */
  maxUnknown: boolean;
}

/**
 * How to present what the server said. The window shown is the server's
 * `effective`; the model's maximum only labels it:
 *
 * - no answer yet: `limit: null` ("—", no percentage);
 * - answered, maximum known and it is the limit: `cappedAt` is set
 *   ("(model max: M)");
 * - answered, maximum known and not the limit: no label;
 * - answered, maximum not known: `maxUnknown` ("(model max unknown)").
 *
 * Only a comparison is made here (is the window the maximum?), never a minimum.
 */
export function describeContextWindow(server: ServerWindow): ContextWindowView {
  const limit = positiveInteger(server.effective);
  if (limit === null) {
    return { limit: null, cappedAt: null, maxUnknown: false };
  }
  const modelMax = positiveInteger(server.modelMax);
  if (modelMax === null) {
    return { limit, cappedAt: null, maxUnknown: true };
  }
  return { limit, cappedAt: limit === modelMax ? modelMax : null, maxUnknown: false };
}

/** The most often a focused window asks the server for the window again. */
export const NUMCTX_FOCUS_REFETCH_MS = 30_000;

/**
 * Whether a window focus should ask the server for the window again: yes when
 * it never has, or last did at least {@link NUMCTX_FOCUS_REFETCH_MS} ago. A tab
 * left open while the config changed elsewhere (another tab, `config.json`)
 * would otherwise show a window the server no longer uses.
 */
export function shouldRefetchNumCtx(now: number, lastFetchedAt: number | null): boolean {
  return lastFetchedAt === null || now - lastFetchedAt >= NUMCTX_FOCUS_REFETCH_MS;
}

/**
 * Whether a `/api/numctx` answer is for a model that is no longer selected. A
 * probe can take seconds, and the user can pick another model meanwhile; the
 * late answer would put the old model's window under the new model's name.
 */
export function isStaleNumCtxAnswer(
  asked: { model: string; providerId: string | null },
  current: { model: string; providerId: string | null }
): boolean {
  return asked.model !== current.model || asked.providerId !== current.providerId;
}

export type NumCtxInput =
  | { kind: 'unchanged' }
  | { kind: 'set'; value: number }
  | { kind: 'invalid' };

/**
 * What the Settings "Context Size" text means.
 *
 * Before this, `Number.parseInt(text) || DEFAULT_NUM_CTX` turned a blank or
 * unparseable field into 131 072 and saved it into `config.json`. Now:
 *
 * - blank while the setting is still unknown (the config has not loaded, so
 *   the user never saw a value): unchanged — saving other settings must not
 *   touch it;
 * - blank while the setting is known: invalid — the user emptied the field;
 * - not a plain positive whole number (`1e6`, `12.5`, `-3`, `0`): invalid;
 * - equal to the current setting: unchanged (so two tabs saving other
 *   settings do not overwrite each other's context size);
 * - otherwise: set.
 */
export function interpretNumCtxInput(text: string, current: number | null): NumCtxInput {
  const trimmed = text.trim();
  if (trimmed === '') {
    return current === null ? { kind: 'unchanged' } : { kind: 'invalid' };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { kind: 'invalid' };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { kind: 'invalid' };
  }
  return value === current ? { kind: 'unchanged' } : { kind: 'set', value };
}
