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
 * support. The resolution order is:
 *
 *   1. Cache hit (TTL-bounded).
 *   2. Probe — when the caller provides a probe function (the chat
 *      route injects one that runs the existing
 *      `info.capabilities` heuristic), use the probe's result.
 *   3. Default — OpenAI-compatible assumes `'supported'` (optimistic
 *      — there is no probe data, and the common case is that the
 *      endpoint does accept images). Ollama assumes `'unsupported'`
 *      when no probe is provided (preserves the pre-fix behaviour
 *      for Ollama, where `/api/show` exposes `capabilities` for
 *      vision models and the absence of that field is a real signal).
 *   4. Cache the result with a 5-minute TTL so subsequent calls in
 *      the same process hit the cache.
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
 * The cache is keyed on (baseUrl, modelName). Two tabs sharing a
 * model share the resolved support state, but a tab using a
 * different (baseUrl, modelName) pair sees its own independent
 * entry — matching the multi-tab contract of `capResolver.ts`.
 */

import type { LlmProvider } from '../types/chatConfig';

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
   *  - `probe`: a caller-supplied probe function returned a value.
   *  - `cache`: hit the TTL-bounded cache.
   *  - `default`: no probe and no cache hit; used the provider's
   *    optimistic default (`supported` for openai-compatible,
   *    `unsupported` for ollama).
   *
   * The 400-driven `recordDiscoveredNonVision` flip is observable
   * only via the cached `state: 'unsupported'` value, not via a
   * distinct source — the next read returns `source: 'cache'`.
   */
  source: 'probe' | 'cache' | 'default';
}

interface CacheEntry {
  state: Exclude<VisionSupportState, 'unknown'>;
  /** Epoch ms after which the entry is stale and should be re-resolved. */
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches capResolver.ts
const cache = new Map<string, CacheEntry>();

function cacheKey(baseUrl: string, modelName: string): string {
  // Use a NUL separator so a model name containing the separator
  // character cannot collide with a baseUrl that happens to contain
  // the same character. NUL is not a valid character in either
  // Ollama base URLs or model names.
  return `${baseUrl}\0${modelName}`;
}

function getCachedEntry(baseUrl: string, modelName: string, now: number): CacheEntry | undefined {
  const entry = cache.get(cacheKey(baseUrl, modelName));
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
  modelName: string,
  state: Exclude<VisionSupportState, 'unknown'>,
  now: number
): void {
  cache.set(cacheKey(baseUrl, modelName), {
    state,
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
export function invalidateVisionCache(baseUrl?: string, modelName?: string): void {
  if (baseUrl === undefined && modelName === undefined) {
    cache.clear();
    return;
  }
  if (modelName === undefined) {
    // Invalidate every entry for this baseUrl, regardless of model.
    for (const key of cache.keys()) {
      if (key.startsWith(`${baseUrl}\0`)) {
        cache.delete(key);
      }
    }
    return;
  }
  cache.delete(cacheKey(baseUrl as string, modelName));
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
  now: number = Date.now()
): void {
  setCachedEntry(baseUrl, modelName, 'unsupported', now);
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

  // 1. Cache hit.
  const cached = getCachedEntry(baseUrl, modelName, now);
  if (cached) {
    return { state: cached.state, source: 'cache' };
  }

  // 2. Probe (if provided AND the provider trusts it). The chat
  //    route injects a probe that wraps the existing
  //    `getLlmModelVisionSupport(info)` call. For `ollama`,
  //    `/api/show` exposes a `capabilities` array and the absence
  //    of `vision` is a real signal — we use it. For
  //    `openai-compatible`, `/v1/models` has no standard
  //    `capabilities` field, so the probe would always return
  //    `false` and poison the cache. We skip the probe for that
  //    provider and fall through to the optimistic default; the
  //    400-driven `recordDiscoveredNonVision` path is the only
  //    way to flip a previously-defaulted openai-compatible model
  //    to `'unsupported'`.
  if (probe && provider !== 'openai-compatible') {
    const result = await probe();
    const state: Exclude<VisionSupportState, 'unknown'> = result ? 'supported' : 'unsupported';
    setCachedEntry(baseUrl, modelName, state, now);
    return { state, source: 'probe' };
  }

  // 3. Provider-default. OpenAI-compatible is optimistic
  //    (`'supported'`) because `/v1/models` has no standard
  //    `capabilities` field, and the common case is the endpoint
  //    does accept images. Ollama is pessimistic
  //    (`'unsupported'`) because `/api/show` exposes capabilities
  //    and the absence of `vision` there is a real signal — the
  //    chat route should use the existing detection path, not
  //    the optimistic default.
  const defaultState: Exclude<VisionSupportState, 'unknown'> =
    provider === 'openai-compatible' ? 'supported' : 'unsupported';
  setCachedEntry(baseUrl, modelName, defaultState, now);
  return { state: defaultState, source: 'default' };
}
