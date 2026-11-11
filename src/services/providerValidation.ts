/**
 * Validation and shaping of one provider entry in `config.json`.
 *
 * Shared by `PUT /api/config` (which validates a whole `providers` list) and
 * `POST /api/providers` (which adds one), so the two accept exactly the same
 * entries and word their errors the same way.
 */

import type { LlmProvider, ProviderConfig } from '@/types/chatConfig';

import { PROVIDER_OLLAMA, PROVIDER_OPENAI_COMPATIBLE } from '@/services/configDefaults';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate one provider. `label` prefixes each message: `providers[0]` for an
 * entry of the list, or `''` for a single provider, where a message reads
 * `name must be a non-empty string`. Returns the cleaned entry, or the message.
 */
export function validateProvider(value: unknown, label: string): ProviderConfig | string {
  const at = (field: string): string => (label ? `${label}.${field}` : field);
  if (!isPlainObject(value)) {
    return `${label || 'provider'} must be an object`;
  }
  if (!isNonEmptyString(value.id)) {
    return `${at('id')} must be a non-empty string`;
  }
  if (!isNonEmptyString(value.name)) {
    return `${at('name')} must be a non-empty string`;
  }
  if (
    typeof value.provider !== 'string' ||
    (value.provider !== PROVIDER_OLLAMA && value.provider !== PROVIDER_OPENAI_COMPATIBLE)
  ) {
    return `${at('provider')} must be '${PROVIDER_OLLAMA}' or '${PROVIDER_OPENAI_COMPATIBLE}'`;
  }
  if (typeof value.baseUrl !== 'string' || value.baseUrl.trim().length === 0) {
    return `${at('baseUrl')} must be a non-empty string`;
  }
  let parsed: URL;
  try {
    parsed = new URL(value.baseUrl);
  } catch {
    return `${at('baseUrl')} is not a valid URL`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${at('baseUrl')} must use http: or https: scheme`;
  }
  const out: ProviderConfig = {
    id: value.id.trim(),
    name: value.name.trim(),
    provider: value.provider as LlmProvider,
    baseUrl: value.baseUrl.trim(),
  };
  if ('apiKey' in value) {
    if (typeof value.apiKey !== 'string') {
      return `${at('apiKey')} must be a string`;
    }
    if (value.apiKey.trim().length > 0) {
      out.apiKey = value.apiKey.trim();
    }
  }
  if ('model' in value) {
    if (typeof value.model !== 'string') {
      return `${at('model')} must be a string`;
    }
    if (value.model.trim().length > 0) {
      out.model = value.model.trim();
    }
  }
  if ('numCtx' in value) {
    if (!isFiniteInteger(value.numCtx) || value.numCtx <= 0) {
      return `${at('numCtx')} must be a positive integer`;
    }
    out.numCtx = value.numCtx;
  }
  return out;
}

/**
 * The base URL as the adapters expect it: no trailing slash (the Ollama adapter
 * builds `${baseUrl}/api/...`), and for an OpenAI-compatible server no trailing
 * `/v1` (the adapter appends `/v1/models` itself, so a pasted `.../v1` would
 * become `/v1/v1/models`). A value that is not a string is returned unchanged
 * for the validator to reject.
 */
export function normaliseProviderBaseUrl(kind: unknown, baseUrl: unknown): unknown {
  if (typeof baseUrl !== 'string') {
    return baseUrl;
  }
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (kind === PROVIDER_OPENAI_COMPATIBLE) {
    url = url.replace(/\/v1$/i, '').replace(/\/+$/, '');
  }
  return url;
}

/** A stable id for a new provider, from its name, that no existing id uses. */
export function uniqueProviderId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const slug =
    name
      .trim()
      .toLowerCase()
      .replaceAll(/[^\da-z]+/g, '-')
      .replaceAll(/^-+|-+$/g, '') || 'provider';
  if (!taken.has(slug)) {
    return slug;
  }
  let n = 2;
  while (taken.has(`${slug}-${n}`)) {
    n += 1;
  }
  return `${slug}-${n}`;
}

/** What the browser is told about a provider: everything except the key itself. */
export interface PublicProvider {
  id: string;
  name: string;
  provider: LlmProvider;
  baseUrl: string;
  model?: string;
  numCtx?: number;
  /** True when a key is stored. The key is never sent back. */
  hasApiKey: boolean;
}

export function toPublicProvider(provider: ProviderConfig): PublicProvider {
  return {
    id: provider.id,
    name: provider.name,
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    ...(provider.model === undefined ? {} : { model: provider.model }),
    ...(provider.numCtx === undefined ? {} : { numCtx: provider.numCtx }),
    hasApiKey: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
  };
}
