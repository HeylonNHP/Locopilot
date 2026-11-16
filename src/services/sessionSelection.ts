/**
 * The model selection a conversation runs on.
 *
 * WHY this file exists: a conversation owns six values that always travel
 * together — the main model, the provider that serves it, the compaction
 * model, the provider that serves that, and the reasoning effort of each
 * model. They cross three boundaries (the SQLite row, the HTTP payloads, the
 * browser's store), and each boundary used to spell them on its own. One
 * vocabulary here is what keeps a conversation's selection from drifting apart
 * between them.
 *
 * Values whose meaning is easy to get wrong are spelled out once here rather
 * than at every call site:
 * - `providerId: null` means "not pinned" — the provider is resolved from the
 *   model name. It does NOT mean "no provider".
 * - `compactionModel: null` means "inherit the global default", while
 *   `compactionModel: ''` means "compact with the conversation's own main
 *   model". The empty string is the same convention `resolveCompactionModel`
 *   already uses on the server, and the two empties are kept apart all the
 *   way down to the database column.
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
 */

import { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from '@/types/chatConfig';

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
  /** The conversation's compaction model, `null` to inherit the global default, `''` for the main model. */
  compactionModel: string | null;
  /** The provider that serves `compactionModel`, or `null` when it is not pinned. */
  compactionProviderId: string | null;
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
 */
export interface SessionSelectionPatch {
  model?: string;
  providerId?: string | null;
  compactionModel?: string | null;
  compactionProviderId?: string | null;
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
  /** The compaction model a new conversation starts with. `''` for the main model. */
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

/** The selection as it arrives on the wire, where every key is optional. */
export interface SessionSelectionPayload {
  model?: unknown;
  providerId?: unknown;
  compactionModel?: unknown;
  compactionProviderId?: unknown;
  reasoningEffort?: unknown;
  compactionReasoningEffort?: unknown;
}

/** The selection a conversation starts with when nothing else is known. */
export function emptySessionSelection(): SessionSelection {
  return {
    model: '',
    providerId: null,
    compactionModel: null,
    compactionProviderId: null,
    reasoningEffort: null,
    compactionReasoningEffort: null,
  };
}

export function selectionFromColumns(columns: SessionSelectionColumns): SessionSelection {
  return {
    model: columns.model,
    providerId: columns.provider_id,
    compactionModel: columns.compaction_model,
    compactionProviderId: columns.compaction_provider_id,
    reasoningEffort: columns.reasoning_effort,
    compactionReasoningEffort: columns.compaction_reasoning_effort,
  };
}

export function selectionToColumns(selection: SessionSelection): SessionSelectionColumns {
  return {
    model: selection.model,
    provider_id: selection.providerId,
    compaction_model: selection.compactionModel,
    compaction_provider_id: selection.compactionProviderId,
    reasoning_effort: selection.reasoningEffort ?? null,
    compaction_reasoning_effort: selection.compactionReasoningEffort ?? null,
  };
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
 * A compaction model: trimmed, `''` for "the conversation's own main model",
 * and `null` for "inherit the global default". The two empties mean different
 * things, so they are kept apart here.
 */
function normaliseCompactionModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim();
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
 * An absent reasoning level is stored as `null` (inherit). Creation pins the
 * resolved values through {@link resolveCreationSelection}, so null only
 * reaches the database when the caller explicitly asked to inherit.
 */
export function validateSessionSelection(value: unknown): SessionSelection | string {
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
  if (
    payload.compactionModel !== undefined &&
    payload.compactionModel !== null &&
    typeof payload.compactionModel !== 'string'
  ) {
    return 'compactionModel must be a string or null';
  }
  if (
    payload.compactionProviderId !== undefined &&
    payload.compactionProviderId !== null &&
    typeof payload.compactionProviderId !== 'string'
  ) {
    return 'compactionProviderId must be a string or null';
  }
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
    compactionModel: normaliseCompactionModel(payload.compactionModel),
    compactionProviderId: normaliseProviderId(payload.compactionProviderId),
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
  if ('compactionModel' in payload) {
    if (payload.compactionModel !== null && typeof payload.compactionModel !== 'string') {
      return 'compactionModel must be a string or null';
    }
    patch.compactionModel = normaliseCompactionModel(payload.compactionModel);
    fieldCount++;
  }
  if ('compactionProviderId' in payload) {
    if (payload.compactionProviderId !== null && typeof payload.compactionProviderId !== 'string') {
      return 'compactionProviderId must be a string or null';
    }
    patch.compactionProviderId = normaliseProviderId(payload.compactionProviderId);
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
    compactionModel:
      patch.compactionModel === undefined ? current.compactionModel : patch.compactionModel,
    compactionProviderId:
      patch.compactionProviderId === undefined
        ? current.compactionProviderId
        : patch.compactionProviderId,
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
