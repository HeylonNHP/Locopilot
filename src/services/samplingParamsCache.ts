/**
 * Server-side cache of "does this model support this sampling parameter?".
 *
 * The bug this module exists to fix: the openai-compatible adapter
 * unconditionally forwards `params.options.*` fields to the upstream provider.
 * For models that don't accept a given parameter (e.g. OpenAI's GPT-5.x
 * reasoning family, including `openai/gpt-5.6-luna` on OpenRouter — whose
 * `supported_parameters` list does not include `temperature`), every chat
 * request fails with a 400. The same problem applies to every standard
 * sampling knob the upstream might reject: `temperature`, `top_p`,
 * `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `logit_bias`.
 *
 * This module is the single backend source of truth for per-parameter
 * support. Fresh runtime discovery is authoritative for the TTL. For
 * openai-compatible providers, a successful `supported_parameters` probe
 * can refresh a weak default (or an older probe), which prevents a
 * metadata-list request from poisoning later chat requests. The resolution
 * policy is:
 *
 *   1. A fresh runtime-discovered rejection wins.
 *   2. A trusted openai-compatible probe refreshes the cache and wins
 *      over defaults.
 *   3. A fresh cache entry is used when no trusted probe is available.
 *   4. Provider default — both openai-compatible and ollama assume
 *      `'supported'`. Ollama's API accepts every sampling knob even when
 *      a specific model ignores it, and a wrong strip is worse than a
 *      redundant field.
 *
 * A failed probe never overwrites a valid cache entry. Every result is
 * cached with a 5-minute TTL so subsequent calls in the same process
 * share state.
 *
 * Reactive 400-driven discovery mirrors the visionCache pattern:
 * `parseUnsupportedParamFromError` (in `src/services/llmContextLimit.ts`)
 * folds a runtime "this model rejected parameter X" signal into the cache
 * so the next turn omits the field without re-hitting the same 400. The
 * chat route's 400 catch block (see `src/app/api/chat/route.ts`) is the
 * single producer of these records.
 *
 * Multi-tab contract
 * -------------------
 * The cache is keyed on (baseUrl, provider, modelName, paramName). Two
 * tabs sharing a provider/model share the resolved support state, but
 * different providers pointed at the same host remain independent.
 */

import type { LlmProvider } from '@/types/chatConfig';

/**
 * Standard sampling parameters the openai-compatible adapter materializes
 * onto outgoing requests. Treated as a registry: a new param name added
 * here is automatically consulted at request-build time without further
 * changes.
 *
 * The order does not affect behavior — the registry is iterated and each
 * param is consulted independently of the others.
 */
export const SAMPLING_PARAM_NAMES = [
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'stop',
  'logit_bias',
] as const;

export type SamplingParamName = (typeof SAMPLING_PARAM_NAMES)[number];

/** Map from sampling-param name to its current support verdict. */
export type SamplingParamSupportMap = Partial<Record<SamplingParamName, boolean>>;

/**
 * The tri-state support verdict the adapter consumes.
 * `'unknown'` is reserved for the period before the cache has been
 * populated; it is never returned by `resolveSamplingParamSupport`
 * itself (the resolver always returns a tri-state result via the
 * optimistic default), but is exposed as a possible source-tag value.
 */
export type SamplingParamSupportState = 'supported' | 'unsupported';

export interface ResolvedSamplingParamSupport {
  /** The resolved support verdict. */
  state: SamplingParamSupportState;
  /**
   * Where the verdict came from. Useful for diagnostics.
   *  - `probe`: a trusted openai-compatible `supported_parameters` probe returned a value.
   *  - `cache`: a fresh cached value was used.
   *  - `default`: no trusted probe or cache was available; used the provider default.
   *
   * Runtime-discovered rejections are reported as `cache` on subsequent
   * reads; their internal provenance gives them precedence over later
   * probes until their TTL expires.
   */
  source: 'probe' | 'cache' | 'default';
}

interface CacheEntry {
  state: SamplingParamSupportState;
  provenance: 'default' | 'probe' | 'discovered';
  /** Epoch ms after which the entry is stale and should be re-resolved. */
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches visionCache.ts
const cache = new Map<string, CacheEntry>();

function cacheKey(
  baseUrl: string,
  provider: LlmProvider | undefined,
  modelName: string,
  paramName: SamplingParamName
): string {
  // Use NUL separators so a model name, provider, or param name
  // containing the separator cannot collide. Including the provider
  // type prevents a shared-baseUrl collision: two providers pointed at
  // the same host (e.g. an ollama and an openai-compatible provider
  // both on localhost:11434) used to share a single (baseUrl,
  // modelName) entry, so a verdict recorded for one leaked to the
  // other.
  return `${baseUrl}\0${provider ?? ''}\0${modelName}\0${paramName}`;
}

function getCachedEntry(
  baseUrl: string,
  provider: LlmProvider | undefined,
  modelName: string,
  paramName: SamplingParamName,
  now: number
): CacheEntry | undefined {
  const entry = cache.get(cacheKey(baseUrl, provider, modelName, paramName));
  if (!entry) {
    return undefined; // miss
  }
  if (entry.expiresAt <= now) {
    return undefined; // stale
  }
  return entry;
}

function setCachedEntry(
  baseUrl: string,
  provider: LlmProvider | undefined,
  modelName: string,
  paramName: SamplingParamName,
  state: SamplingParamSupportState,
  provenance: CacheEntry['provenance'],
  now: number
): void {
  cache.set(cacheKey(baseUrl, provider, modelName, paramName), {
    state,
    provenance,
    expiresAt: now + CACHE_TTL_MS,
  });
}

/** Test helper: drop all cached sampling-param-support entries. */
export function clearSamplingParamCache(): void {
  cache.clear();
}

/**
 * Invalidate cached sampling-param-support entries so the next call to
 * `resolveSamplingParamSupport` re-resolves the support state. Use this
 * when the user changes the model, switches baseUrl, or swaps providers.
 * Without invalidation, the stale 5-minute cache would continue to
 * report the old verdict for the next 5 minutes.
 *
 * - If `baseUrl`, `modelName`, and `paramName` are all provided, only the
 *   one matching entry is removed.
 * - If only `baseUrl` and `modelName` are provided, every param for that
 *   (baseUrl, modelName, provider) pair is removed.
 * - If only `baseUrl` is provided, all entries for that URL are removed.
 * - If nothing is provided, the entire cache is cleared.
 */
export function invalidateSamplingParamCache(
  baseUrl?: string,
  modelName?: string,
  provider?: LlmProvider,
  paramName?: SamplingParamName
): void {
  if (baseUrl === undefined && modelName === undefined && paramName === undefined) {
    cache.clear();
    return;
  }
  if (modelName === undefined && paramName === undefined) {
    // Invalidate every entry for this baseUrl, regardless of model,
    // provider, or param name.
    for (const key of cache.keys()) {
      if (key.startsWith(`${baseUrl}\0`)) {
        cache.delete(key);
      }
    }
    return;
  }
  if (paramName === undefined) {
    // Invalidate every param for this (baseUrl, modelName, provider) triple.
    const basePrefix = `${baseUrl}\0${provider ?? ''}\0${modelName}\0`;
    for (const key of cache.keys()) {
      if (key.startsWith(basePrefix)) {
        cache.delete(key);
      }
    }
    return;
  }
  if (provider === undefined) {
    // Preserve targeted-invalidation behavior for callers that do not
    // yet know the provider: remove every provider-qualified entry for
    // this (baseUrl, modelName, paramName) triple.
    const prefix = `${baseUrl}\0`;
    const suffix = `\0${modelName}\0${paramName}`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        cache.delete(key);
      }
    }
    return;
  }
  cache.delete(cacheKey(baseUrl!, provider, modelName!, paramName));
}

/**
 * Update the cached sampling-param support for a model based on a 400
 * error response from the LLM. Used by the chat route's catch block
 * to fold a runtime "this model rejected parameter X" signal into the
 * cache so the next turn omits the field without re-hitting the same
 * 400. The new state takes effect immediately for the rest of the
 * process; the existing TTL is reset to 5 minutes from now.
 *
 * A `discovered` entry takes precedence over later probes until its
 * TTL expires (see `resolveSamplingParamSupport` for the full
 * precedence order), so a single 400 is enough to teach the cache.
 */
export function recordDiscoveredUnsupportedParam(
  baseUrl: string,
  modelName: string,
  paramName: SamplingParamName,
  provider: LlmProvider = 'ollama',
  now: number = Date.now()
): void {
  setCachedEntry(baseUrl, provider, modelName, paramName, 'unsupported', 'discovered', now);
}

/**
 * Resolve the support state for a single sampling parameter, using the
 * cache, the optional probe, and the provider's optimistic default.
 * See the module-level docstring for the full resolution order and
 * rationale.
 *
 * The probe, when provided, returns the param's verdict from a trusted
 * upstream metadata source (e.g. OpenRouter's `/v1/models` list).
 */
export async function resolveSamplingParamSupport(
  baseUrl: string,
  modelName: string,
  paramName: SamplingParamName,
  provider: LlmProvider,
  probe?: () => SamplingParamSupportState | Promise<SamplingParamSupportState>,
  now: number = Date.now()
): Promise<ResolvedSamplingParamSupport> {
  const cached = getCachedEntry(baseUrl, provider, modelName, paramName, now);

  // A discovered rejection is direct runtime evidence and wins over a
  // later probe until its TTL expires.
  if (cached?.provenance === 'discovered') {
    return { state: cached.state, source: 'cache' };
  }

  if (probe) {
    try {
      const result = await probe();
      const state: SamplingParamSupportState = result;
      // A successful probe is stronger than a default or older probe.
      // Refresh the expiry so active model-list refreshes keep
      // authoritative metadata.
      setCachedEntry(baseUrl, provider, modelName, paramName, state, 'probe', now);
      return { state, source: 'probe' };
    } catch {
      // A failed probe must not replace a valid cached result. If
      // there is no cache, fall through to the provider default below.
      if (cached) return { state: cached.state, source: 'cache' };
    }
  }

  if (cached) return { state: cached.state, source: 'cache' };

  const defaultState: SamplingParamSupportState = 'supported';
  setCachedEntry(baseUrl, provider, modelName, paramName, defaultState, 'default', now);
  return { state: defaultState, source: 'default' };
}

/**
 * Resolve the support verdict for every sampling parameter in
 * `SAMPLING_PARAM_NAMES` for a (baseUrl, modelName, provider) triple.
 *
 * The probe, when provided, returns the full per-parameter map for
 * the model (e.g. `{ temperature: false, top_p: true, ... }`). Params
 * absent from the probe's returned map keep their existing cache
 * entry or fall through to the provider default.
 *
 * Useful as a single round-trip in the chat route, where every
 * standard sampling param is consulted before the request loop.
 */
export async function resolveSamplingParamSupportMap(
  baseUrl: string,
  modelName: string,
  provider: LlmProvider,
  probe?: () => SamplingParamSupportMap | Promise<SamplingParamSupportMap>,
  now: number = Date.now()
): Promise<Record<SamplingParamName, ResolvedSamplingParamSupport>> {
  const probedMap = probe ? await Promise.resolve(probe()).catch(() => {}) : undefined;
  const result = {} as Record<SamplingParamName, ResolvedSamplingParamSupport>;
  for (const paramName of SAMPLING_PARAM_NAMES) {
    const probeFn = (() => {
      const verdict = probedMap ? probedMap[paramName] : undefined;
      if (verdict === true) return (): SamplingParamSupportState => 'supported';
      if (verdict === false) return (): SamplingParamSupportState => 'unsupported';
      return;
    })();
    result[paramName] = await resolveSamplingParamSupport(
      baseUrl,
      modelName,
      paramName,
      provider,
      probeFn,
      now
    );
  }
  return result;
}
