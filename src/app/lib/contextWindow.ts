/**
 * The context window the UI shows and the request bodies send — in one place,
 * with no placeholder.
 *
 * The rule the user asked for: the window shown (and used) is the one they
 * chose in Settings, unless the selected model supports less, in which case it
 * is the model's maximum. The client used to keep a stand-in value
 * (`DEFAULT_NUM_CTX`, 131 072) for "the config has not loaded yet", and that
 * stand-in leaked: a reloaded session showed "276922/131072 tokens (211%)"
 * for a model that supports 1 000 000, Settings could save the stand-in into
 * `config.json`, and a request could carry it.
 *
 * "I do not know yet" is therefore a first-class state here — `null` — and
 * every consumer decides what to show for it ("—") instead of inventing a
 * number. Everything in this module is pure so the rules are pinned by
 * scripts/test-context-window.mjs.
 */

/**
 * A positive safe integer, or `null` for anything else (0, negatives, NaN,
 * fractions, strings, `undefined`). The one definition of "a usable window
 * size" on the client; it matches what `PUT /api/config` accepts.
 */
export function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export interface ContextWindowInputs {
  /** The user's setting. `null` until the config has loaded. */
  requested: number | null;
  /** The selected model's maximum as the server reported it; absent when it has not. */
  modelMax?: number | null | undefined;
  /**
   * A limit the server reported for a past turn (0 or absent = none). It is a
   * snapshot of the setting AT THAT TURN, so it is only used while the setting
   * itself is unknown — never to override a setting the user has since changed.
   */
  reportedLimit?: number | null | undefined;
  /** The window the server last resolved. Same rule as {@link reportedLimit}. */
  effective?: number | null | undefined;
}

export interface ContextWindowView {
  /** The window to show and to compute percentages against; `null` while unknown. */
  limit: number | null;
  /** The model's maximum, set only when it is BELOW the user's setting (so it is the limit). */
  cappedAt: number | null;
}

/**
 * min(the user's setting, the model's reported maximum) — and nothing else.
 *
 * - Setting known: the setting, clamped to the model's maximum when that is
 *   known and lower. A stale per-turn snapshot never wins over it.
 * - Setting unknown (config not loaded yet): the server's last reported
 *   window if there is one, else `null`. Never a default.
 */
export function resolveContextWindow(inputs: ContextWindowInputs): ContextWindowView {
  const requested = positiveInteger(inputs.requested);
  const modelMax = positiveInteger(inputs.modelMax);

  if (requested !== null) {
    if (modelMax !== null && modelMax < requested) {
      return { limit: modelMax, cappedAt: modelMax };
    }
    return { limit: requested, cappedAt: null };
  }

  return {
    limit: positiveInteger(inputs.reportedLimit) ?? positiveInteger(inputs.effective),
    cappedAt: null,
  };
}

/**
 * The `numCtx` field of a request body: present only when the setting is
 * known. While it is unknown the field is OMITTED — the server then reads the
 * persisted config — instead of sending a stand-in value that the server
 * would trust over the config (a body value wins on the server).
 */
export function numCtxField(requested: number | null): { numCtx?: number } {
  const value = positiveInteger(requested);
  return value === null ? {} : { numCtx: value };
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

/**
 * A stored request body with its `numCtx` replaced by the setting as it is now.
 * Retry uses it: the body was saved when the turn was first sent, and replaying
 * it verbatim would replay the window the user had then. A body that is not a
 * JSON object is returned unchanged.
 */
export function withCurrentNumCtx(body: string, requested: number | null): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return body;
  }
  const next: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  delete next.numCtx;
  return JSON.stringify({ ...next, ...numCtxField(requested) });
}
