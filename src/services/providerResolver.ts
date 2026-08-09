/**
 * Multi-provider resolution utilities.
 *
 * The config stores an array of `ProviderConfig` objects under
 * `providers`. This module resolves a provider by ID or by model name
 * and builds a per-request LLM context from the resolved provider.
 * Legacy single-provider configs (top-level `provider`/`baseUrl`/
 * `apiKey`) are rejected at startup — see scripts/validateConfig.mjs.
 */

import type { Config, ProviderConfig } from '@/types/chatConfig';

import { DEFAULT_NUM_CTX } from '@/constants';

import { buildLlmRequestContext, type LlmRequestContext } from './llm';

/**
 * Return the config's providers array. Returns an empty array when the
 * config has no providers — legacy configs are rejected at startup, so
 * there is nothing to synthesize here.
 */
export function getNormalizedProviders(config: Config | null): ProviderConfig[] {
  return config?.providers && config.providers.length > 0 ? config.providers : [];
}

/**
 * Resolve a provider from the config.
 *
 * Resolution order:
 *  1. An explicit `providerId` that actually exists — this is the user's
 *     selection and always wins.
 *  2. A provider whose default `model` matches `modelName` — the safe
 *     recovery both for a stale `providerId` and for requests that only
 *     carry a model name.
 *  3. If a `providerId` was supplied but neither rule matched, return
 *     `null` rather than an unrelated provider. Falling back to
 *     `providers[0]` here would cross-wire another endpoint's apiKey /
 *     baseUrl to this request.
 *  4. No `providerId` and no model match — return the first provider as
 *     the default.
 *
 * Returns `null` only when there are no providers at all, or when an
 * explicit `providerId` could not be resolved safely.
 */
export function resolveProvider(
  config: Config | null,
  providerId?: string,
  modelName?: string
): ProviderConfig | null {
  const providers = getNormalizedProviders(config);
  if (providers.length === 0) return null;

  if (providerId) {
    const byId = providers.find((p) => p.id === providerId);
    if (byId) return byId;
  }

  if (modelName) {
    const byModel = providers.find((p) => p.model === modelName);
    if (byModel) return byModel;
  }

  // A stale explicit id must not cross-wire to an unrelated provider.
  if (providerId) return null;

  return providers[0] ?? null;
}

/**
 * Build a per-request LLM context from a resolved provider. This is the
 * single place where a `ProviderConfig` is converted into the wire context
 * the adapters consume.
 *
 * `requestId` is the route's per-request correlation UUID. It is optional
 * so callers that don't have one (e.g. background jobs) can still build a
 * context, but every chat/api route should pass it through.
 */
export function buildProviderRequestContext(
  provider: ProviderConfig,
  requestId?: string
): LlmRequestContext {
  return buildLlmRequestContext({
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

/**
 * Convenience: resolve a provider and build its request context in one
 * call. Returns `null` when no provider can be resolved.
 */
export function resolveProviderRequestContext(
  config: Config | null,
  providerId?: string,
  modelName?: string,
  requestId?: string
): { provider: ProviderConfig; ctx: LlmRequestContext } | null {
  const provider = resolveProvider(config, providerId, modelName);
  if (!provider) return null;
  return { provider, ctx: buildProviderRequestContext(provider, requestId) };
}

/**
 * Return the effective numCtx for a provider, falling back to the global
 * config value and ultimately to a default.
 */
export function getProviderNumCtx(provider: ProviderConfig, globalNumCtx?: number): number {
  return provider.numCtx ?? globalNumCtx ?? DEFAULT_NUM_CTX;
}
