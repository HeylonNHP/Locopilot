/**
 * The model selection a conversation runs on.
 *
 * WHY this file exists: a conversation owns six values that always travel
 * together — the main model, the provider that serves it, the compaction
 * selection, and the reasoning effort of each model. They cross three
 * boundaries (the SQLite row, the HTTP payloads, the browser's store), and
 * each boundary used to spell them on its own. One vocabulary here is what
 * keeps a conversation's selection from drifting apart between them.
 *
 * Values whose meaning is easy to get wrong are spelled out once here rather
 * than at every call site:
 * - `providerId: null` means "not pinned" — the provider is resolved from the
 *   model name. It does NOT mean "no provider".
 * - `reasoningEffort: null` (and `compactionReasoningEffort: null`) means
 *   "inherit the global default". `'off'` is a real pinned level, not the same
 *   thing: a row written before per-conversation levels existed is NULL and
 *   keeps following the default until the user picks a level.
 *
 * The selection is written in two shapes:
 * - {@link SessionSelection} — the complete row. Creation
 *   (`POST /api/sessions`, the chat route's lazy `createSession`) and the
 *   merged result of a patch use this.
 * - {@link SessionSelectionPatch} — every field optional. A `PATCH` carries
 *   only what the control edited, so a pick of one field can never erase
 *   another and two tabs editing different fields do not clobber each other.
 *
 * THE COMPACTION SELECTION IS ONE VALUE, NOT TWO FIELDS. It used to be two
 * independent nullable fields (`compactionModel` + `compactionProviderId`),
 * which admitted a fourth state — "a model, but no provider" — that sent a
 * compaction model to an endpoint that did not have it. That state is now
 * unrepresentable: see {@link CompactionSelection}.
 */

import { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from '@/types/chatConfig';

/**
 * The conversation's compaction selection: ONE value with THREE states.
 *
 * WHY a union and not two nullable columns: the compaction MODEL and the
 * PROVIDER that serves it are one fact, and they used to be two independent
 * nullable fields. That encoding admitted a fourth state — "a model, but no
 * provider" — which is the production failure this whole effort exists to
 * end: a model name says nothing about which endpoint serves it, so the
 * compaction call went to an endpoint that did not have the model and came
 * back 404.
 *
 * The three states below are the three legal combinations, and the fourth
 * combination has no spelling at all:
 *
 * - `inherit-default` — use the global default compaction pair.
 * - `same-as-main` — use the conversation's OWN main model, on the main
 *   provider (the same model AND the same provider as the chat).
 * - `explicit` — a named model on a named provider. The provider is part of
 *   the value, so "a model with no provider" cannot be written.
 *
 * The database columns still hold two values (the schema is not changed — see
 * `docs/PROVIDER_PAIR_PLAN.md`), but the pair is only ever produced by
 * {@link compactionSelectionToPair} and only ever read by
 * {@link compactionSelectionFromColumns}, so the illegal combination cannot
 * reach the row.
 */
export type CompactionSelection =
  /** Use the global default compaction model and provider. */
  | { kind: 'inherit-default' }
  /** Use the conversation's own main model, on the main provider. */
  | { kind: 'same-as-main' }
  /** A named compaction model, on the named provider that serves it. */
  | { kind: 'explicit'; model: string; providerId: string };

/** The selection that inherits the global default. */
export function inheritDefaultCompactionSelection(): CompactionSelection {
  return { kind: 'inherit-default' };
}

/** The selection that compacts with the conversation's own main model. */
export function sameAsMainCompactionSelection(): CompactionSelection {
  return { kind: 'same-as-main' };
}

/** The selection that compacts with `model` on the provider `providerId`. */
export function explicitCompactionSelection(
  model: string,
  providerId: string
): CompactionSelection {
  return { kind: 'explicit', model, providerId };
}

/**
 * The selection a pair of loose fields describes — or the reason the pair is
 * incoherent.
 *
 * The pair used to be two independent nullable fields, so it admitted states
 * that mean nothing: a model with no provider (the 404), and a provider with
 * no model. Both are REFUSED here, with a message that says what to send
 * instead — never silently repaired, because a silent repair is a compaction
 * that quietly runs on an endpoint the user did not choose.
 *
 * `null` / `undefined` mean "not sent". An empty model means "the
 * conversation's own main model" — the convention the rule already uses.
 */
export function compactionSelectionFromPair(
  model: string | null | undefined,
  providerId: string | null | undefined
): { ok: true; selection: CompactionSelection } | { ok: false; error: string } {
  const trimmedModel = typeof model === 'string' ? model.trim() : '';
  const trimmedProvider = typeof providerId === 'string' ? providerId.trim() : '';
  const modelGiven = typeof model === 'string';
  const providerGiven = trimmedProvider !== '';

  if (!modelGiven) {
    if (providerGiven) {
      return {
        ok: false,
        error:
          'A compaction provider was sent without a compaction model. Pick a compaction model (and the provider that serves it) together.',
      };
    }
    return { ok: true, selection: inheritDefaultCompactionSelection() };
  }
  if (trimmedModel === '') {
    // "Same as the conversation's own main model". The provider it would run
    // on is the MAIN provider, so a provider sent alongside it is dropped
    // rather than refused — the rule has always ignored it, and refusing it
    // would break a control that sends the whole pair.
    return { ok: true, selection: sameAsMainCompactionSelection() };
  }
  if (!providerGiven) {
    return {
      ok: false,
      error: `The compaction model "${trimmedModel}" was sent without the provider that serves it. Pick a compaction model and provider together.`,
    };
  }
  return { ok: true, selection: explicitCompactionSelection(trimmedModel, trimmedProvider) };
}

/**
 * The selection a loose pair describes, without the ability to complain.
 *
 * For the places that must not fail — reading a stored row, showing what a
 * conversation compacts with. A pair that is not coherent resolves to
 * "inherit the global default", which is the safe direction: the global pair
 * always names a model AND a provider that belong together.
 */
export function compactionSelectionFromLoosePair(
  model: string | null | undefined,
  providerId: string | null | undefined
): CompactionSelection {
  const parsed = compactionSelectionFromPair(model, providerId);
  if (parsed.ok) return parsed.selection;
  // An incoherent pair is repaired as faithfully as the halves allow: a model
  // of `''` ("same as the main model") keeps that meaning and drops the
  // provider it cannot have; a NAMED model without its provider falls back to
  // the global default, because no provider can be invented for it.
  if (typeof model === 'string' && model.trim() === '') {
    return sameAsMainCompactionSelection();
  }
  return inheritDefaultCompactionSelection();
}

/**
 * The two loose fields a selection is stored as.
 *
 * The pair travels together: an `explicit` selection always carries both
 * halves, so the columns can never hold a model without a provider.
 */
export function compactionSelectionToPair(selection: CompactionSelection): {
  model: string | null;
  providerId: string | null;
} {
  switch (selection.kind) {
    case 'inherit-default': {
      return { model: null, providerId: null };
    }
    case 'same-as-main': {
      return { model: '', providerId: null };
    }
    case 'explicit': {
      return { model: selection.model, providerId: selection.providerId };
    }
  }
}

/**
 * A coherent compaction pair, from whatever the two loose fields held.
 *
 * The half-pair (a model without the provider that serves it) is repaired
 * HERE, on the way in and on the way out, so no caller — the browser store, a
 * request body, a database row — ever holds it. The repair is the safe
 * direction: the pair falls back to "inherit the global default", which
 * always names a model AND a provider that belong together.
 */
export function coherentCompactionPair(
  model: string | null | undefined,
  providerId: string | null | undefined
): { model: string | null; providerId: string | null } {
  return compactionSelectionToPair(compactionSelectionFromLoosePair(model, providerId));
}

/**
 * The model a LEGACY provider-only compaction pin is paired with: the global
 * compaction model, else the conversation's own main model.
 *
 * It is the order the server resolved a model-less pin in before the pair
 * became one value (the body, then `config.compactionModel`, then the main
 * model), so a stale tab keeps the compaction model its pin ran with. Every
 * endpoint that reads the legacy shape (chat, compact, title, session
 * creation, mid-turn switch) calls THIS, so the same body can never resolve to
 * a different selection per endpoint (bug hunt A1).
 *
 * Returns '' when neither is known; `compactionSelectionFromPayload` then
 * refuses the body with a message that says so.
 */
export function legacyCompactionFallbackModel(
  globalCompactionModel: string | null | undefined,
  mainModel: string | null | undefined
): string {
  const global = globalCompactionModel?.trim() ?? '';
  return global === '' ? (mainModel?.trim() ?? '') : global;
}

/**
 * The selection a request body carries — the NEW union, or the LEGACY pair.
 *
 * The legacy shape (`compactionModel` + `compactionProviderId`, two
 * independent fields) is still read, for a tab that was open before the
 * change. It is read HERE and nowhere else, so there is exactly one place
 * that knows what a stale tab sends.
 *
 * A legacy pair that names a model WITHOUT its provider is REFUSED: it is the
 * state that sent a compaction model to an endpoint that did not have it. A
 * legacy pair that names a provider WITHOUT a model has its model resolved to
 * `fallbackModel` and becomes an `explicit` selection. Callers pass
 * {@link legacyCompactionFallbackModel}, so every endpoint agrees on it.
 */
export function compactionSelectionFromPayload(
  payload: {
    compaction?: unknown;
    compactionModel?: unknown;
    compactionProviderId?: unknown;
  },
  fallbackModel: string
): { ok: true; selection: CompactionSelection } | { ok: false; error: string } {
  if (payload.compaction !== undefined && payload.compaction !== null) {
    return parseCompactionSelection(payload.compaction);
  }
  const providerGiven =
    typeof payload.compactionProviderId === 'string' && payload.compactionProviderId.trim() !== '';
  if (typeof payload.compactionModel !== 'string' && providerGiven) {
    const providerId = (payload.compactionProviderId as string).trim();
    const model = fallbackModel.trim();
    if (model === '') {
      return {
        ok: false,
        error:
          'A compaction provider was sent without a compaction model, and no model is known to pair it with.',
      };
    }
    return { ok: true, selection: explicitCompactionSelection(model, providerId) };
  }
  return compactionSelectionFromPair(
    typeof payload.compactionModel === 'string' ? payload.compactionModel : undefined,
    typeof payload.compactionProviderId === 'string' ? payload.compactionProviderId : undefined
  );
}

/**
 * The selection a wire payload describes, or the reason it does not.
 *
 * The union is checked at runtime because the wire is untrusted: an
 * `explicit` selection without a model, or with an empty provider id, is the
 * half-pair in disguise and is REFUSED rather than repaired.
 */
export function parseCompactionSelection(
  value: unknown
): { ok: true; selection: CompactionSelection } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'compaction must be an object' };
  }
  const payload = value as { kind?: unknown; model?: unknown; providerId?: unknown };
  if (payload.kind === 'inherit-default') {
    return { ok: true, selection: inheritDefaultCompactionSelection() };
  }
  if (payload.kind === 'same-as-main') {
    return { ok: true, selection: sameAsMainCompactionSelection() };
  }
  if (payload.kind === 'explicit') {
    const model = typeof payload.model === 'string' ? payload.model.trim() : '';
    const providerId = typeof payload.providerId === 'string' ? payload.providerId.trim() : '';
    if (model === '') {
      return {
        ok: false,
        error:
          'The compaction selection names no model. Send the compaction model and the provider that serves it together.',
      };
    }
    if (providerId === '') {
      return {
        ok: false,
        error: `The compaction model "${model}" was sent without the provider that serves it. Send the compaction model and the provider that serves it together.`,
      };
    }
    return { ok: true, selection: explicitCompactionSelection(model, providerId) };
  }
  return {
    ok: false,
    error:
      'compaction must be one of: "inherit-default", "same-as-main", or "explicit" (with a model and a provider).',
  };
}

/**
 * The selection a picker's choice describes.
 *
 * The model picker offers three things for the compaction model: "use the
 * default", "same as the conversation's own main model", and a named model.
 * This maps the three onto the union:
 * - `null` — inherit the global default;
 * - `''` — the conversation's own main model, on the main provider;
 * - a name — that model, on the provider that serves it.
 *
 * A named model with NO provider is the state the union exists to prevent,
 * so it is refused here rather than repaired: `null` comes back and the
 * caller reports the refusal. The provider cannot be invented — a model
 * name says nothing about which endpoint serves it.
 */
export function compactionSelectionForModel(
  model: string | null | undefined,
  providerId: string | null | undefined
): CompactionSelection | null {
  if (model === null || model === undefined) return inheritDefaultCompactionSelection();
  const trimmedModel = model.trim();
  if (trimmedModel === '') return sameAsMainCompactionSelection();
  const trimmedProvider = typeof providerId === 'string' ? providerId.trim() : '';
  if (trimmedProvider === '') return null;
  return explicitCompactionSelection(trimmedModel, trimmedProvider);
}

/**
 * Whether two selections describe the SAME choice.
 *
 * The selection is an object, so `===` compares identity rather than meaning:
 * two selections built from the same row are different objects. This is the
 * comparison the browser uses to decide whether a selection changed — "the
 * user picked something" and "the row says the same thing again" must not
 * look alike.
 */
export function compactionSelectionEquals(a: CompactionSelection, b: CompactionSelection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'explicit' && b.kind === 'explicit') {
    return a.model === b.model && a.providerId === b.providerId;
  }
  return true;
}

/**
 * The selection as the database stores it. The column names are the ones the
 * `sessions` table actually has, so a row can be read as this shape without
 * a translation step.
 */
export interface SessionSelectionColumns {
  /** The conversation's main model. Never empty. */
  model: string;
  /** The provider that serves `model`, or `null` when it is not pinned. */
  provider_id: string | null;
  /** The conversation's compaction model, or `null` to inherit the global default. */
  compaction_model: string | null;
  /** The provider that serves `compaction_model`, or `null` when it is not pinned. */
  compaction_provider_id: string | null;
  /** The main model's reasoning level, or `null` to inherit the global default. */
  reasoning_effort: ReasoningEffort | null;
  /** The compaction model's reasoning level, or `null` to inherit the global default. */
  compaction_reasoning_effort: ReasoningEffort | null;
}

/** The selection as the code speaks about it. */
export interface SessionSelection {
  /** The conversation's main model. Never empty. */
  model: string;
  /** The provider that serves `model`, or `null` when it is not pinned. */
  providerId: string | null;
  /**
   * The conversation's compaction selection — ONE value, so a compaction
   * model can never be pinned without the provider that serves it.
   */
  compaction: CompactionSelection;
  /** The main model's reasoning level, or `null` to inherit the global default. */
  reasoningEffort: ReasoningEffort | null;
  /** The compaction model's reasoning level, or `null` to inherit the global default. */
  compactionReasoningEffort: ReasoningEffort | null;
}

/**
 * A field-preserving change to a conversation's selection.
 *
 * `undefined` (the key is absent) means "leave the stored value alone";
 * `null` means "inherit the global default"; a value means "pin this".
 *
 * The compaction selection is ONE field: a patch states the whole selection
 * or none of it. There is no way to edit one half of the pair, because
 * editing one half alone leaves the other half describing a DIFFERENT choice
 * — a new model on the provider that was pinned for the old one is the
 * wrong-endpoint 404 this whole rule exists to prevent.
 */
export interface SessionSelectionPatch {
  model?: string;
  providerId?: string | null;
  compaction?: CompactionSelection;
  reasoningEffort?: ReasoningEffort | null;
  compactionReasoningEffort?: ReasoningEffort | null;
}

/**
 * The global settings a NEW conversation starts with.
 *
 * They are separate from a conversation's selection because a pick of one
 * does not change the other: picking the main model leaves the default
 * compaction model alone, and picking the compaction model leaves the
 * default main model alone. The reasoning levels follow the same rule.
 */
export interface SessionDefaults {
  /** The model a new conversation starts with. */
  model: string;
  /** The provider that serves `model`, or `null` when it is not pinned. */
  providerId: string | null;
  /**
   * The global compaction model. `''` means "the conversation's own main
   * model".
   *
   * The GLOBAL pair keeps its two-field shape — it is `config.json`'s shape,
   * and the file is hand-edited. "A global model with no provider of its own"
   * has a meaning (the model, on the provider the chat runs on), so it is not
   * the incoherent state the conversation's own pair was.
   */
  compactionModel: string;
  /**
   * The provider that serves the default compaction model, or `null` when it
   * is not pinned.
   *
   * This is the global half of the pair: it applies to a conversation only
   * while that conversation INHERITS the default compaction model. A
   * conversation that pins its own compaction model needs its own provider
   * pin too, or it runs on the main chat provider.
   */
  compactionProviderId: string | null;
  /** The main model's reasoning level a new conversation starts with. */
  reasoningEffort: ReasoningEffort;
  /** The compaction model's reasoning level a new conversation starts with. */
  compactionReasoningEffort: ReasoningEffort;
}

/** A field-preserving change to the global defaults. */
export interface SessionDefaultsPatch {
  model?: string;
  providerId?: string | null;
  compactionModel?: string;
  /**
   * `undefined` leaves the stored value alone; `null` clears it (the
   * compaction then runs on the main chat provider); a value pins it.
   */
  compactionProviderId?: string | null;
  reasoningEffort?: ReasoningEffort;
  compactionReasoningEffort?: ReasoningEffort;
}

/**
 * The selection as it arrives on the wire, where every key is optional.
 *
 * The two legacy flat fields are still read: a tab that was open before the
 * pair became one value keeps sending them.
 */
export interface SessionSelectionPayload {
  model?: unknown;
  providerId?: unknown;
  /** The compaction selection, as ONE value. */
  compaction?: unknown;
  /** @deprecated the legacy flat compaction model. */
  compactionModel?: unknown;
  /** @deprecated the legacy flat compaction provider. */
  compactionProviderId?: unknown;
  reasoningEffort?: unknown;
  compactionReasoningEffort?: unknown;
}

/** The selection a conversation starts with when nothing else is known. */
export function emptySessionSelection(): SessionSelection {
  return {
    model: '',
    providerId: null,
    compaction: inheritDefaultCompactionSelection(),
    reasoningEffort: null,
    compactionReasoningEffort: null,
  };
}

export function selectionFromColumns(columns: SessionSelectionColumns): SessionSelection {
  // A row written before the pair was one value can still hold a model with
  // no provider. It is normalised to "inherit the global default" HERE, on
  // the read path, so no caller ever sees the illegal combination. The
  // bootstrap migration in `src/services/history.ts` fixes the rows
  // themselves; this is the second line of defence.
  return {
    model: columns.model,
    providerId: columns.provider_id,
    compaction: compactionSelectionFromLoosePair(
      columns.compaction_model,
      columns.compaction_provider_id
    ),
    reasoningEffort: columns.reasoning_effort,
    compactionReasoningEffort: columns.compaction_reasoning_effort,
  };
}

export function selectionToColumns(selection: SessionSelection): SessionSelectionColumns {
  // The pair is NORMALISED on the way out, so the illegal combination
  // cannot reach the row even if a caller built one by hand. The repair is
  // the SAME one the read path uses (`compactionSelectionFromLoosePair`),
  // so the row and a browser that reads it back agree - and so the frame
  // that announces the change can be the pair that was actually written.
  //
  // The write paths REFUSE an incoherent pair before they get here; this is
  // the belt to that pair of braces.
  const loose = compactionSelectionToPair(selection.compaction);
  const pair = coherentCompactionPair(loose.model, loose.providerId);
  return {
    model: selection.model,
    provider_id: selection.providerId,
    compaction_model: pair.model,
    compaction_provider_id: pair.providerId,
    reasoning_effort: selection.reasoningEffort ?? null,
    compaction_reasoning_effort: selection.compactionReasoningEffort ?? null,
  };
}

/**
 * The reason a LEGACY compaction-pair patch may not be applied, or `null`
 * when it may.
 *
 * This is the guard for the OLD wire shape — two independent flat fields —
 * which a tab open before the change still sends. The pair is ONE value
 * there too, so such a patch states BOTH halves or NEITHER: editing one half
 * alone leaves the other half describing a DIFFERENT choice.
 *
 * The NEW wire shape needs no such guard: the patch carries the whole
 * selection as one value, so a half-pair has no spelling.
 */
export function legacyCompactionPairPatchProblem(patch: {
  compactionModel?: string | null | undefined;
  compactionProviderId?: string | null | undefined;
}): string | null {
  const hasModel = patch.compactionModel !== undefined;
  const hasProvider = patch.compactionProviderId !== undefined;
  if (hasModel === hasProvider) {
    // Both halves, or neither: nothing to object to.
    return null;
  }
  if (!hasModel) {
    return 'The compaction provider was changed without the compaction model it serves. Send "compactionModel" and "compactionProviderId" together.';
  }
  const model = patch.compactionModel;
  if (model === null || model === '') {
    // "Inherit the default" and "the conversation's own main model" name no
    // provider because they have none — but the row may still hold one, and
    // a provider left behind would describe a model that is no longer
    // chosen. The caller has to say what happens to it.
    return 'The compaction model was changed without the compaction provider it travels with. Send "compactionModel" and "compactionProviderId" together.';
  }
  return `The compaction model "${model}" was changed without the provider that serves it. Send "compactionModel" and "compactionProviderId" together.`;
}

/**
 * A provider id: trimmed, or `null` when it was absent or empty. An id that
 * does not name a configured provider is the server's problem to detect (it
 * knows the provider list); this only normalises the shape.
 */
function normaliseProviderId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A reasoning level: `null` for "inherit the global default", a valid level
 * otherwise. Returns the reason it is invalid rather than coercing, because a
 * silently dropped level is a setting the user cannot see going missing.
 *
 * The result is a discriminated object on purpose: a valid level is itself a
 * string (`'high'`), so "string means error" would reject every legal value.
 */
function parseReasoningLevel(
  field: string,
  value: unknown
): { ok: true; value: ReasoningEffort | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isReasoningEffort(value)) {
    return {
      ok: false,
      error: `${field} must be one of: ${REASONING_EFFORTS.join(', ')}`,
    };
  }
  return { ok: true, value };
}

/**
 * Validate a selection arriving from a request body.
 *
 * Returns the cleaned selection, or the reason it is invalid — the same
 * "value or message" contract `validateProvider` uses, so the caller can
 * branch on `typeof validated === 'string'`.
 *
 * The compaction selection is read through {@link compactionSelectionFromPayload},
 * so the NEW union and the LEGACY flat pair are both accepted, and an
 * incoherent one is refused with a message that says what to send instead.
 *
 * An absent reasoning level is stored as `null` (inherit). Creation pins the
 * resolved values through {@link resolveCreationSelection}, so null only
 * reaches the database when the caller explicitly asked to inherit.
 */
export function validateSessionSelection(
  value: unknown,
  /** The saved global compaction model, for a legacy provider-only pin. */
  globalCompactionModel?: string | null
): SessionSelection | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'The model selection must be an object';
  }
  const payload = value as SessionSelectionPayload;
  if (typeof payload.model !== 'string' || payload.model.trim().length === 0) {
    return 'model must be a non-empty string';
  }
  if (
    payload.providerId !== undefined &&
    payload.providerId !== null &&
    typeof payload.providerId !== 'string'
  ) {
    return 'providerId must be a string or null';
  }
  const compaction = compactionSelectionFromPayload(
    payload,
    legacyCompactionFallbackModel(globalCompactionModel, payload.model)
  );
  if (!compaction.ok) return compaction.error;
  const reasoningEffort = parseReasoningLevel('reasoningEffort', payload.reasoningEffort);
  if (!reasoningEffort.ok) return reasoningEffort.error;
  const compactionReasoningEffort = parseReasoningLevel(
    'compactionReasoningEffort',
    payload.compactionReasoningEffort
  );
  if (!compactionReasoningEffort.ok) return compactionReasoningEffort.error;
  return {
    model: payload.model.trim(),
    providerId: normaliseProviderId(payload.providerId),
    compaction: compaction.selection,
    reasoningEffort: reasoningEffort.value,
    compactionReasoningEffort: compactionReasoningEffort.value,
  };
}

/**
 * Validate a field-preserving change.
 *
 * Only the keys present in the payload appear in the result, so the caller can
 * merge it without touching the fields the user did not edit. An empty patch
 * is refused: it is always a caller bug, and silently accepting it would hide
 * a selection control that saved nothing.
 */
export function validateSessionSelectionPatch(value: unknown): SessionSelectionPatch | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'The model selection patch must be an object';
  }
  const payload = value as Record<string, unknown>;
  const patch: SessionSelectionPatch = {};
  let fieldCount = 0;

  if ('model' in payload) {
    if (typeof payload.model !== 'string' || payload.model.trim().length === 0) {
      return 'model must be a non-empty string';
    }
    patch.model = payload.model.trim();
    fieldCount++;
  }
  if ('providerId' in payload) {
    if (payload.providerId !== null && typeof payload.providerId !== 'string') {
      return 'providerId must be a string or null';
    }
    patch.providerId = normaliseProviderId(payload.providerId);
    fieldCount++;
  }

  // The compaction selection: the NEW union, or the LEGACY flat pair. The
  // legacy pair has its own guard — it can name ONE half of the pair, which
  // the new shape cannot express at all.
  const legacyModelGiven = 'compactionModel' in payload;
  const legacyProviderGiven = 'compactionProviderId' in payload;
  if (legacyModelGiven || legacyProviderGiven) {
    const legacyModel = legacyModelGiven ? payload.compactionModel : undefined;
    const legacyProvider = legacyProviderGiven ? payload.compactionProviderId : undefined;
    if (legacyModel !== undefined && legacyModel !== null && typeof legacyModel !== 'string') {
      return 'compactionModel must be a string or null';
    }
    if (
      legacyProvider !== undefined &&
      legacyProvider !== null &&
      typeof legacyProvider !== 'string'
    ) {
      return 'compactionProviderId must be a string or null';
    }
    const pairProblem = legacyCompactionPairPatchProblem({
      compactionModel: legacyModel,
      compactionProviderId: legacyProvider,
    });
    if (pairProblem !== null) return pairProblem;
    const parsed = compactionSelectionFromPair(
      typeof legacyModel === 'string' ? legacyModel : undefined,
      typeof legacyProvider === 'string' ? legacyProvider : undefined
    );
    if (!parsed.ok) return parsed.error;
    patch.compaction = parsed.selection;
    fieldCount++;
  }
  if ('compaction' in payload) {
    const parsed = parseCompactionSelection(payload.compaction);
    if (!parsed.ok) return parsed.error;
    patch.compaction = parsed.selection;
    fieldCount++;
  }

  if ('reasoningEffort' in payload) {
    const level = parseReasoningLevel('reasoningEffort', payload.reasoningEffort);
    if (!level.ok) return level.error;
    patch.reasoningEffort = level.value;
    fieldCount++;
  }
  if ('compactionReasoningEffort' in payload) {
    const level = parseReasoningLevel(
      'compactionReasoningEffort',
      payload.compactionReasoningEffort
    );
    if (!level.ok) return level.error;
    patch.compactionReasoningEffort = level.value;
    fieldCount++;
  }

  if (fieldCount === 0) {
    return 'The model selection patch must contain at least one field';
  }
  return patch;
}

/**
 * Merge a validated patch onto a conversation's stored selection.
 *
 * An absent key keeps the stored value; an explicit `null` clears it to
 * "inherit". This is the one place the merge rule lives, so the route and any
 * future caller cannot drift on it.
 */
export function mergeSessionSelection(
  current: SessionSelection,
  patch: SessionSelectionPatch
): SessionSelection {
  return {
    model: patch.model ?? current.model,
    providerId: patch.providerId === undefined ? current.providerId : patch.providerId,
    compaction: patch.compaction ?? current.compaction,
    reasoningEffort:
      patch.reasoningEffort === undefined ? current.reasoningEffort : patch.reasoningEffort,
    compactionReasoningEffort:
      patch.compactionReasoningEffort === undefined
        ? current.compactionReasoningEffort
        : patch.compactionReasoningEffort,
  };
}

/**
 * Pin the reasoning levels a NEW conversation was born with.
 *
 * The server resolves "what the caller did not pin" from the saved defaults, so
 * a conversation created after a default change starts on the new value and a
 * later change does not move it. `'off'` is the last resort, matching the
 * adapter convention that an absent level means "no explicit level".
 */
export function resolveCreationSelection(
  selection: SessionSelection,
  defaults: {
    reasoningEffort?: ReasoningEffort | undefined;
    compactionReasoningEffort?: ReasoningEffort | undefined;
  }
): SessionSelection {
  return {
    ...selection,
    reasoningEffort: selection.reasoningEffort ?? defaults.reasoningEffort ?? 'off',
    compactionReasoningEffort:
      selection.compactionReasoningEffort ?? defaults.compactionReasoningEffort ?? 'off',
  };
}
