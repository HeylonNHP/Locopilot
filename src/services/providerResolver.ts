/**
 * Multi-provider resolution utilities.
 *
 * The legacy single-provider config stored `provider`, `baseUrl`, `apiKey`,
 * and `model` at the top level. The multi-provider config stores an array
 * of `ProviderConfig` objects under `providers`. This module bridges the
 * two: it can synthesize a providers list from legacy fields, resolve a
 * provider by ID or by model name, and build a per-request LLM context
 * from the resolved provider.
 */

import type { Config, LlmProvider, ProviderConfig } from '@/types/chatConfig';

import { DEFAULT_NUM_CTX } from '@/constants';

import { buildLlmRequestContext, type LlmRequestContext } from './llm';

/**
 * Stable id for the synthetic provider created from legacy top-level config
 * fields. Using a constant (rather than slugifying the display name) keeps
 * the id deterministic across name changes and avoids colliding with a
 * user-authored provider id that happens to slug-match the synthetic name.
 */
const LEGACY_PROVIDER_ID = 'legacy';

/**
 * Normalize any config into a non-empty providers array. If the config
 * already has `providers`, return it. Otherwise synthesize a single
 * provider from the legacy top-level `provider`/`baseUrl`/`apiKey`/`model`
 * fields. This keeps old `config.json` files working unchanged.
 */
export function getNormalizedProviders(config: Config | null): ProviderConfig[] {
  if (config?.providers && config.providers.length > 0) {
    return config.providers;
  }

  const baseUrl = config?.baseUrl ?? 'http://localhost:11434';
  const provider: LlmProvider = config?.provider ?? 'ollama';
  const name = config?.apiKey
    ? `${provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible'} (${baseUrl.replace(/^https?:\/\//, '').split('/')[0]})`
    : provider === 'ollama'
      ? 'Ollama'
      : 'OpenAI-compatible';

  return [
    {
      id: LEGACY_PROVIDER_ID,
      name,
      provider,
      baseUrl,
      ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config?.model ? { model: config.model } : {}),
      ...(config?.numCtx ? { numCtx: config.numCtx } : {}),
    },
  ];
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
 */
export function buildProviderRequestContext(provider: ProviderConfig): LlmRequestContext {
  return buildLlmRequestContext({
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
  });
}

/**
 * Convenience: resolve a provider and build its request context in one
 * call. Returns `null` when no provider can be resolved.
 */
export function resolveProviderRequestContext(
  config: Config | null,
  providerId?: string,
  modelName?: string
): { provider: ProviderConfig; ctx: LlmRequestContext } | null {
  const provider = resolveProvider(config, providerId, modelName);
  if (!provider) return null;
  return { provider, ctx: buildProviderRequestContext(provider) };
}

/**
 * Return the effective numCtx for a provider, falling back to the global
 * config value and ultimately to a default.
 */
export function getProviderNumCtx(provider: ProviderConfig, globalNumCtx?: number): number {
  return provider.numCtx ?? globalNumCtx ?? DEFAULT_NUM_CTX;
}
