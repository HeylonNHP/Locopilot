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

import type { Config, LlmProvider, ProviderConfig } from '../types/chatConfig';

import { buildLlmRequestContext, type LlmRequestContext } from './llm';

/**
 * Generate a short, deterministic ID from a provider name. Used for the
 * synthetic provider created from legacy top-level config fields.
 */
function slugFromProviderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'default';
}

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
      id: slugFromProviderName(name),
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
 * Resolve a provider from the config. Prefer `providerId` when supplied,
 * otherwise fall back to a provider whose `model` matches `modelName`, and
 * finally to the first provider. Returns `null` only when there is no
 * config at all.
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
  return provider.numCtx ?? globalNumCtx ?? 8192;
}
