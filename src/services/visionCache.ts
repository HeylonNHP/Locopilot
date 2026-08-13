/**
 * Server-side cache of "does this model support image (vision) input?".
 *
 * The bug this module exists to fix: image attachments are silently
 * stripped from outgoing OpenAI-compatible chat requests because
 * `getLlmModelVisionSupport` only inspects `LlmModelInfo.capabilities`,
 * and the OpenAI `/v1/models` endpoint has no standard `capabilities`
 * field — so for every OpenAI-compatible model, the heuristic returns
 * `false` and `buildChatPayload` strips the image before the LLM sees
 * it. The user attaches an image, sees the thumbnail in their own
 * bubble, and the model receives text only.
 *
 * This module is the single backend source of truth for vision
 * support. Fresh runtime discovery is authoritative for the TTL. For Ollama,
 * a successful `/api/show` probe can refresh a weak default (or an older
 * probe), which prevents a metadata-list request from poisoning later chat
 * requests. The resolution policy is:
 *
 *   1. A fresh runtime-discovered rejection wins.
 *   2. A trusted Ollama probe refreshes the cache and wins over defaults.
 *   3. A fresh cache entry is used when no trusted probe is available.
 *   4. Provider default — OpenAI-compatible assumes `'supported'`; Ollama
 *      assumes `'unsupported'` when no capabilities probe is available.
 *
 * A failed probe never overwrites a valid cache entry. Every result is cached
 * with a 5-minute TTL so subsequent calls in the same process share state.
 *
 * Reactive 400-driven discovery mirrors the capResolver pattern:
 * `recordDiscoveredNonVision` folds a runtime "this model rejected
 * image input" signal into the cache so the next turn strips
 * images without re-hitting the same 400. The chat route's 400
 * catch block (see `src/app/api/chat/route.ts`) is the single
 * producer of these records; `parseVisionUnsupportedFromError` in
 * `src/services/llmContextLimit.ts` is the matcher.
 *
 * Multi-tab contract
 * -------------------
 * The cache is keyed on (baseUrl, provider, modelName). Two tabs sharing a
 * provider/model share the resolved support state, but different providers
 * pointed at the same host remain independent.
 */

import type { LlmProvider } from '@/types/chatConfig';

/**
 * The tri-state vision-support verdict the UI and the chat route
 * consume. `'unknown'` is reserved for the period before the cache
 * has been populated; it is never returned by `resolveVisionSupport`
 * itself (the resolver always returns a tri-state result via the
 * optimistic default), but is exposed as the initial value on
 * `ChatState.visionState` so the UI can render the "unconfirmed"
 * hint cleanly during the first turn.
 */
export type VisionSupportState = 'supported' | 'unsupported' | 'unknown';

export interface ResolvedVisionSupport {
  /** The resolved support verdict. */
  state: VisionSupportState;
  /**
   * Where the verdict came from. Useful for diagnostics and for the
   * `/api/models` projection (which uses `source === 'default'` to
   * know it should surface the optimistic "Vision" badge).
   *  - `probe`: a trusted Ollama capabilities probe returned a value.
   *  - `cache`: a fresh cached value was used.
   *  - `default`: no trusted probe or cache was available; used the provider
   *    default (`supported` for openai-compatible, `unsupported` for ollama).
   *
   * Runtime-discovered rejections are reported as `cache` on subsequent reads;
   * their internal provenance gives them precedence over later probes.
   */
  source: 'probe' | 'cache' | 'default';
}

interface CacheEntry {
  state: Exclude<VisionSupportState, 'unknown'>;
  provenance: 'default' | 'probe' | 'discovered';
  /** Epoch ms after which the entry is stale and should be re-resolved. */
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches capResolver.ts
const cache = new Map<string, CacheEntry>();

function cacheKey(baseUrl: string, provider: LlmProvider | undefined, modelName: string): string {
  // Use NUL separators so a model name or provider containing the separator
  // cannot collide. Including the provider type prevents a shared-baseUrl
  // collision: two providers pointed at the same host (e.g. an ollama and an
  // openai-compatible provider both on localhost:11434) used to share a single
  // (baseUrl, modelName) entry, so an 'unsupported' verdict recorded for one
  // leaked to the other (which optimistically assumes 'supported').
  return `${baseUrl}\0${provider ?? ''}\0${modelName}`;
}

function getCachedEntry(
  baseUrl: string,
  provider: LlmProvider | undefined,
  modelName: string,
  now: number
): CacheEntry | undefined {
  const entry = cache.get(cacheKey(baseUrl, provider, modelName));
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
  state: Exclude<VisionSupportState, 'unknown'>,
  provenance: CacheEntry['provenance'],
  now: number
): void {
  cache.set(cacheKey(baseUrl, provider, modelName), {
    state,
    provenance,
    expiresAt: now + CACHE_TTL_MS,
  });
}

/** Test helper: drop all cached vision-support entries. */
export function clearVisionCache(): void {
  cache.clear();
}

/**
 * Invalidate cached vision-support entries so the next call to
 * `resolveVisionSupport` re-resolves the support state for the
 * (baseUrl, modelName) pair. Use this when the user changes the
 * model, switches baseUrl, or swaps providers. Without invalidation,
 * the stale 5-minute cache would continue to report the old
 * verdict for the next 5 minutes.
 *
 * - If `baseUrl` and `modelName` are both provided, only the one
 *   matching entry is removed.
 * - If only `baseUrl` is provided, all entries for that URL are
 *   removed (e.g. when the user switches provider hosts).
 * - If neither is provided, the entire cache is cleared.
 */
export function invalidateVisionCache(
  baseUrl?: string,
  modelName?: string,
  provider?: LlmProvider
): void {
  if (baseUrl === undefined && modelName === undefined) {
    cache.clear();
    return;
  }
  if (modelName === undefined) {
    // Invalidate every entry for this baseUrl, regardless of model or provider.
    for (const key of cache.keys()) {
      if (key.startsWith(`${baseUrl}\0`)) {
        cache.delete(key);
      }
    }
    return;
  }
  if (provider === undefined) {
    // Preserve the public targeted-invalidation behavior for callers that do
    // not yet know the provider: remove every provider-qualified entry for
    // this baseUrl/model pair.
    const prefix = `${baseUrl}\0`;
    const suffix = `\0${modelName}`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        cache.delete(key);
      }
    }
    return;
  }
  cache.delete(cacheKey(baseUrl!, provider, modelName));
}

/**
 * Update the cached vision support for a model based on a 400 error
 * response from the LLM. Used by the chat route's catch block to
 * fold a runtime "this model rejected image input" signal into the
 * cache so the next turn strips images without re-hitting the same
 * 400. The new state takes effect immediately for the rest of the
 * process; the existing TTL is reset to 5 minutes from now.
 */
export function recordDiscoveredNonVision(
  baseUrl: string,
  modelName: string,
  provider: LlmProvider = 'ollama',
  now: number = Date.now()
): void {
  setCachedEntry(baseUrl, provider, modelName, 'unsupported', 'discovered', now);
}

/**
 * Resolve the vision support state for a (baseUrl, modelName) pair,
 * using the cache, the optional probe, and the provider's optimistic
 * default. See the module-level docstring for the full resolution
 * order and rationale.
 */
export async function resolveVisionSupport(
  baseUrl: string,
  modelName: string,
  provider: LlmProvider,
  probe?: () => boolean | Promise<boolean>
): Promise<ResolvedVisionSupport> {
  const now = Date.now();
  const cached = getCachedEntry(baseUrl, provider, modelName, now);

  // OpenAI-compatible capability metadata is not a trustworthy probe. A
  // runtime rejection is still authoritative and must remain effective.
  if (provider === 'openai-compatible') {
    if (cached) return { state: cached.state, source: 'cache' };
    const defaultState: Exclude<VisionSupportState, 'unknown'> = 'supported';
    setCachedEntry(baseUrl, provider, modelName, defaultState, 'default', now);
    return { state: defaultState, source: 'default' };
  }

  // A discovered rejection is direct runtime evidence and wins over a later
  // capabilities probe until its TTL expires.
  if (cached?.provenance === 'discovered') {
    return { state: cached.state, source: 'cache' };
  }

  if (probe) {
    try {
      const result = await probe();
      const state: Exclude<VisionSupportState, 'unknown'> = result ? 'supported' : 'unsupported';
      // A successful probe is stronger than a default or older probe. Refresh
      // the expiry so active model-list refreshes keep authoritative metadata.
      setCachedEntry(baseUrl, provider, modelName, state, 'probe', now);
      return { state, source: 'probe' };
    } catch {
      // A failed probe must not replace a valid cached result. If there is no
      // cache, fall through to the provider default below.
      if (cached) return { state: cached.state, source: 'cache' };
    }
  }

  if (cached) return { state: cached.state, source: 'cache' };

  const defaultState: Exclude<VisionSupportState, 'unknown'> = 'unsupported';
  setCachedEntry(baseUrl, provider, modelName, defaultState, 'default', now);
  return { state: defaultState, source: 'default' };
}
