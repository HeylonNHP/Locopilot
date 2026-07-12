/**
 * Server-side resolver for the effective context-window size of a chat
 * request.
 *
 * The "effective" numCtx is what should actually be sent to the model:
 *
 *     effective = min(requestedNumCtx, modelContextLimit)
 *
 * where `modelContextLimit` is the model's runtime cap (what the
 * running Ollama runner will actually enforce, not what the modelfile
 * declares) and `requestedNumCtx` is what the user configured. If the
 * cap is unknown, `effective = requestedNumCtx`.
 *
 * This module is the single backend source of truth for the cap. The
 * client must NOT apply the clamp itself; it sends the user's
 * requested value, the server resolves the cap, and the resolved
 * `effective` value is reported back to the client on every `status`
 * SSE event. See `WEBUI_MIGRATION.md §"numCtx preservation across
 * model changes"` for the full design.
 *
 * Multi-tab contract
 * -------------------
 * The cap cache is keyed on (baseUrl, modelName). The cache is
 * process-wide (intentional: cap discovery is amortised across tabs),
 * but the key discipline prevents one tab's model from leaking into
 * another tab's cap:
 *
 *   - `baseUrl` is part of the key because two Ollama instances on
 *     different URLs can host the same model name with different caps.
 *   - The key is the model name exactly as supplied — no
 *     normalisation, no case folding, no tag stripping. `qwen3:6.35b`
 *     and `qwen3:6.35b-instruct` are two distinct cache entries.
 *
 * Two tabs using two different models therefore see two different caps
 * on their respective chat responses, and neither tab's in-flight turn
 * is influenced by the other tab's choice. A `clearCapCache` test
 * helper is exported for the smoke-test harness.
 */

import {
  fetchLlmModelInfo,
  fetchLlmRunningModelContextLength,
  getLlmModelContextLimit,
  type LlmRequestContext,
} from './llm';

/** Result of resolving a chat request's effective numCtx. */
export interface ResolvedNumCtx {
  /** The user's requested value, clamped to the model's cap if known. */
  effective: number;
  /** The user's requested value, as passed in (unclamped). */
  requested: number;
  /** The model's capability cap (from `/api/show` model_info). null if unknown. */
  modelCap: number | null;
  /**
   * The runner's current KV-cache allocation (from `/api/ps`). Informational
   * only — does not affect `effective`. Useful for UI hints and diagnostics.
   * Null when the model is not currently loaded or the provider has no
   * runtime probe.
   */
  runtime: number | null;
  /** Where the modelCap came from, for diagnostics. */
  source: 'static-show' | 'runtime-ps' | 'cache' | 'unknown';
}

interface CacheEntry {
  cap: number | null;
  /** Epoch ms after which the entry is stale and should be re-resolved. */
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry>();

function cacheKey(baseUrl: string, modelName: string): string {
  // Use a NUL separator so a model name containing the separator
  // character cannot collide with a baseUrl that happens to contain
  // the same character. NUL is not a valid character in either
  // Ollama base URLs or model names.
  return `${baseUrl}\0${modelName}`;
}

function getCachedCap(baseUrl: string, modelName: string, now: number): number | null | undefined {
  const entry = cache.get(cacheKey(baseUrl, modelName));
  if (!entry) {
    return undefined; // miss
  }
  if (entry.expiresAt <= now) {
    return undefined; // stale
  }
  return entry.cap;
}

function setCachedCap(baseUrl: string, modelName: string, cap: number | null, now: number): void {
  cache.set(cacheKey(baseUrl, modelName), {
    cap,
    expiresAt: now + CACHE_TTL_MS,
  });
}

/** Test helper: drop all cached cap entries. */
export function clearCapCache(): void {
  cache.clear();
}

/**
 * Invalidate cached cap entries so the next call to
 * `resolveEffectiveNumCtx` re-probes the provider.
 *
 * Use this when the user changes the model or updates the config in
 * a way that should re-trigger discovery — switching models,
 * switching `baseUrl`, or raising `requestedNumCtx` above the
 * cached cap. Without invalidation, the stale 5-minute cache
 * continues to report the old cap for the next 5 minutes.
 *
 * - If `baseUrl` and `modelName` are both provided, only the one
 *   matching entry is removed.
 * - If only `baseUrl` is provided, all entries for that URL are
 *   removed (e.g. when the user switches Ollama instances).
 * - If neither is provided, the entire cache is cleared.
 */
export function invalidateCapCache(baseUrl?: string, modelName?: string): void {
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
 * Resolve the effective context-window size for a (baseUrl, modelName)
 * pair, given the user's requested numCtx.
 *
 * The cap authority is the **static probe** (per-adapter
 * `getModelContextLimit`, typically backed by Ollama `/api/show`'s
 * `model_info.<arch>.context_length`). This is the model's
 * capability — the training-time max context that Ollama will not
 * exceed when allocating a runner. The user's request is sent to
 * Ollama as `options.num_ctx` and Ollama's scheduler reloads the
 * runner with the new size if it differs from the current
 * allocation.
 *
 * The runtime probe (`/api/ps`) is informational: it reports the
 * runner's *current* KV-cache allocation, which is a transient
 * state Ollama will change automatically. We still call it (so the
 * UI can show "(runner at N)" hints) but its value never affects
 * `effective`.
 *
 * The resolution order is:
 *
 *   1. Cache hit (TTL-bounded).
 *   2. Static probe (per-adapter `getModelContextLimit`, typically
 *      backed by `/api/show`) — the model's capability cap.
 *   3. Runtime probe (Ollama `/api/ps`) — collected for telemetry
 *      but does NOT affect the cap. Used as a last-resort fallback
 *      only when the static probe is unavailable.
 *   4. `null` cap (no probe succeeded). The effective value is then
 *      equal to the requested value, and Ollama will reject the
 *      request with 400 if it's beyond the model's real cap.
 *
 * The cap result is cached so subsequent requests for the same
 * model hit the cache for up to 5 minutes. This is
 * per-(baseUrl, modelName), not per-request, so two tabs sharing
 * a model share the resolved cap. Use `invalidateCapCache` to
 * force a re-probe (e.g. after the user changes the model or
 * updates the config).
 */
export async function resolveEffectiveNumCtx(
  ctx: LlmRequestContext,
  modelName: string,
  requestedNumCtx: number
): Promise<ResolvedNumCtx> {
  const now = Date.now();
  const requested = Math.max(0, Math.floor(requestedNumCtx));
  // The cap cache is keyed on (baseUrl, modelName). baseUrl is part of
  // the per-request context, so two tabs with different baseUrls still
  // see independent caps.
  const baseUrl = ctx.baseUrl;

  // 1. Cache hit.
  const cached = getCachedCap(baseUrl, modelName, now);
  if (cached !== undefined) {
    return {
      effective: cached === null ? requested : Math.min(requested, cached),
      requested,
      modelCap: cached,
      runtime: null,
      source: 'cache',
    };
  }

  // 2. Static probe — the model's capability cap.
  let cap: number | null = null;
  let source: ResolvedNumCtx['source'] = 'unknown';
  try {
    const modelInfo = await fetchLlmModelInfo(ctx, modelName);
    cap = getLlmModelContextLimit(modelInfo);
    if (cap !== null) {
      source = 'static-show';
    }
  } catch {
    // Static probe is best-effort; fall through.
  }

  // 3. Runtime probe — informational only. Run in parallel with the
  //    static probe would be nicer but the per-request cost is
  //    negligible (one extra HTTP call) and serial is simpler.
  let runtime: number | null = null;
  try {
    runtime = await fetchLlmRunningModelContextLength(ctx, modelName);
  } catch {
    // Runtime probe is best-effort.
  }

  // 3a. Last-resort fallback: if the static probe returned nothing,
  //     use the runtime probe as the cap. This keeps the legacy
  //     "runtime as cap" behaviour for the case where /api/show
  //     doesn't expose a `context_length` (older Ollama, some
  //     OpenAI-compatible providers).
  if (cap === null && runtime !== null) {
    cap = runtime;
    source = 'runtime-ps';
  }

  setCachedCap(baseUrl, modelName, cap, now);

  return {
    effective: cap === null ? requested : Math.min(requested, cap),
    requested,
    modelCap: cap,
    runtime,
    source,
  };
}

/**
 * Update the cached cap for a model based on a 400 error response from
 * the LLM. Used by the chat route's catch block to fold a
 * runtime-discovered cap (smaller than the proactive probe) into the
 * cache so the next turn uses the right value without another 400.
 *
 * The new cap takes effect immediately for the rest of the process;
 * the existing TTL is reset to 5 minutes from now.
 */
export function recordDiscoveredCap(
  baseUrl: string,
  modelName: string,
  cap: number,
  now: number = Date.now()
): void {
  setCachedCap(baseUrl, modelName, cap, now);
}
