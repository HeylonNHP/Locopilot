/**
 * The model selection a conversation runs on.
 *
 * WHY this file exists: a conversation owns four values that always travel
 * together — the main model, the provider that serves it, the compaction
 * model, and the provider that serves that. They cross three boundaries (the
 * SQLite row, the HTTP payloads, the browser's store), and each boundary used
 * to spell them on its own. One vocabulary here is what keeps a
 * conversation's selection from drifting apart between them.
 *
 * Two of the values have meanings that are easy to get wrong, so they are
 * spelled out once here rather than at every call site:
 * - `providerId: null` means "not pinned" — the provider is resolved from the
 *   model name. It does NOT mean "no provider".
 * - `compactionModel: null` means "inherit the global default", while
 *   `compactionModel: ''` means "compact with the conversation's own main
 *   model". The empty string is the same convention `resolveCompactionModel`
 *   already uses on the server, and the two empties are kept apart all the
 *   way down to the database column.
 */

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
}

/** The selection as it arrives on the wire, where every key is optional. */
export interface SessionSelectionPayload {
  model?: unknown;
  providerId?: unknown;
  compactionModel?: unknown;
  compactionProviderId?: unknown;
}

/** The selection a conversation starts with when nothing else is known. */
export function emptySessionSelection(): SessionSelection {
  return {
    model: '',
    providerId: null,
    compactionModel: null,
    compactionProviderId: null,
  };
}

export function selectionFromColumns(columns: SessionSelectionColumns): SessionSelection {
  return {
    model: columns.model,
    providerId: columns.provider_id,
    compactionModel: columns.compaction_model,
    compactionProviderId: columns.compaction_provider_id,
  };
}

export function selectionToColumns(selection: SessionSelection): SessionSelectionColumns {
  return {
    model: selection.model,
    provider_id: selection.providerId,
    compaction_model: selection.compactionModel,
    compaction_provider_id: selection.compactionProviderId,
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
 * Validate a selection arriving from a request body.
 *
 * Returns the cleaned selection, or the reason it is invalid — the same
 * "value or message" contract `validateProvider` uses, so the caller can
 * branch on `typeof validated === 'string'`.
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
  return {
    model: payload.model.trim(),
    providerId: normaliseProviderId(payload.providerId),
    compactionModel: normaliseCompactionModel(payload.compactionModel),
    compactionProviderId: normaliseProviderId(payload.compactionProviderId),
  };
}
