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
} from './llm';

/** Result of resolving a chat request's effective numCtx. */
export interface ResolvedNumCtx {
  /** The user's requested value (clamped to the model's runtime cap if known). */
  effective: number;
  /** The user's requested value, as passed in (unclamped). */
  requested: number;
  /** The model's runtime cap, or null if unknown. */
  modelCap: number | null;
  /** Where the modelCap came from, for diagnostics. */
  source: 'runtime-ps' | 'static-show' | 'cache' | 'unknown';
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
 * Resolve the effective context-window size for a (baseUrl, modelName)
 * pair, given the user's requested numCtx.
 *
 * The resolution order is:
 *
 *   1. Cache hit (TTL-bounded).
 *   2. Runtime probe (Ollama `/api/ps`) — authoritative when the
 *      model is currently loaded in a runner.
 *   3. Static probe (per-adapter `getModelContextLimit`, typically
 *      backed by `/api/show`) — falls back when the model is not
 *      loaded or no runtime probe is available.
 *   4. `null` cap (model not probed, no info available). The effective
 *      value is then equal to the requested value.
 *
 * The result is cached so subsequent requests for the same model hit
 * the cache for up to 5 minutes. This is per-(baseUrl, modelName),
 * not per-request, so two tabs sharing a model share the resolved
 * cap.
 */
export async function resolveEffectiveNumCtx(
  baseUrl: string,
  modelName: string,
  requestedNumCtx: number
): Promise<ResolvedNumCtx> {
  const now = Date.now();
  const requested = Math.max(0, Math.floor(requestedNumCtx));

  // 1. Cache hit.
  const cached = getCachedCap(baseUrl, modelName, now);
  if (cached !== undefined) {
    return {
      effective: cached === null ? requested : Math.min(requested, cached),
      requested,
      modelCap: cached,
      source: 'cache',
    };
  }

  // 2. Runtime probe.
  let cap: number | null = null;
  let source: ResolvedNumCtx['source'] = 'unknown';
  try {
    cap = await fetchLlmRunningModelContextLength(baseUrl, modelName);
    if (cap !== null) {
      source = 'runtime-ps';
    }
  } catch {
    // Runtime probe is best-effort; fall through to the static probe.
  }

  // 3. Static probe.
  if (cap === null) {
    try {
      const modelInfo = await fetchLlmModelInfo(baseUrl, modelName);
      cap = getLlmModelContextLimit(modelInfo);
      if (cap !== null) {
        source = 'static-show';
      }
    } catch {
      // Static probe is also best-effort; cap stays null.
    }
  }

  setCachedCap(baseUrl, modelName, cap, now);

  return {
    effective: cap === null ? requested : Math.min(requested, cap),
    requested,
    modelCap: cap,
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
