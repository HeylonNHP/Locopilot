/**
 * Probe-and-cache layer for a model's context MAXIMUM.
 *
 * The window the app plans with is
 *
 *     effective = min(setting, modelMax)    when the maximum is known
 *     effective = setting                   when it is not
 *
 * `resolveNumCtx` (`./contextWindow/resolveNumCtx.ts`) is the one place that
 * computes it. This module answers only "what is this model's maximum, and how
 * do we know?". The client never computes it; the server reports it.
 *
 * Where the maximum comes from (never `/api/ps`, which reports a runner's
 * current allocation and can under-cap):
 *
 *   - Ollama (local or cloud): `/api/show`, via the adapter ('static').
 *   - llama.cpp: `meta.n_ctx` of a LOADED model only ('llamacpp-loaded'). Its
 *     `context_length` is the trained window and is ignored.
 *   - Other OpenAI-compatible servers: the `/v1/models` entry ('openai-models').
 *     NVIDIA publishes none, so its maximum is unknown.
 *   - Any provider: a 400 whose body states the limit ('learned').
 *
 * Caching and timeouts:
 *
 *   - A probe is abandoned after `CAP_PROBE_TIMEOUT_MS` (10 s). `fetchModelInfo`
 *     takes no abort signal, so this is a race against a timer, not a cancel.
 *   - A successful probe is cached for 5 minutes, including "answered, but
 *     states no maximum" (NVIDIA), so an unknowable maximum is not re-probed on
 *     every turn.
 *   - A failed or timed-out probe is cached for 60 s, so a dead endpoint does
 *     not stall every turn for 10 s. The turn proceeds with no known maximum.
 *   - A limit learned from a 400 is cached for 5 minutes and is never replaced
 *     by a probe while it is fresh: a shorter cache would let the retry hit
 *     the same 400 again.
 *   - Concurrent callers for one key share one probe.
 *
 * Multi-tab contract: the cache is process-wide on purpose (discovery is
 * amortised across tabs), keyed on (baseUrl, provider kind, model) exactly as
 * supplied, with no normalisation. Two tabs on two models never see each
 * other's maximum. The provider kind is in the key because one endpoint can be
 * reached through both adapters, and they read the maximum from different
 * places.
 */

import type { ModelMaxSource } from '@/types/numCtx';

import type { LlmModelInfo } from './adapters/llmAdapter';

import { fetchLlmModelInfo, getLlmModelContextLimit, type LlmRequestContext } from './llm';
import { isLlamaCppModelInfo } from './llmContextLimit';

/** How long one model-info probe may run before it counts as failed. */
export const CAP_PROBE_TIMEOUT_MS = 10_000;
/** How long a successful probe is trusted. */
export const CAP_SUCCESS_TTL_MS = 5 * 60 * 1000;
/** How long a failed or timed-out probe is remembered. */
export const CAP_FAILURE_TTL_MS = 60 * 1000;
/** How long a limit learned from a provider's 400 is trusted. */
export const CAP_LEARNED_TTL_MS = 5 * 60 * 1000;

/** What is known about one model's maximum context window. */
export interface ModelMax {
  /** The maximum in tokens, or null when it is not known. */
  modelMax: number | null;
  source: ModelMaxSource;
  /** Why the last probe failed (timeout, unreachable, …); null otherwise. */
  probeError: string | null;
}

type EntryKind = 'probed' | 'failed' | 'learned';

interface CacheEntry extends ModelMax {
  kind: EntryKind;
  /** Epoch ms after which the entry is stale and is probed again. */
  expiresAt: number;
  baseUrl: string;
  provider: string;
  model: string;
}

/** What a probe needs from the outside world; replaceable in tests. */
export interface CapProbeDeps {
  fetchModelInfo(ctx: LlmRequestContext, modelName: string): Promise<LlmModelInfo>;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  timeoutMs: number;
}

const defaultDeps: CapProbeDeps = {
  fetchModelInfo: fetchLlmModelInfo,
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  timeoutMs: CAP_PROBE_TIMEOUT_MS,
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ModelMax>>();

/** The provider kind a context talks to; no provider means the Ollama default. */
function providerKind(provider: string | undefined): string {
  return provider ?? 'ollama';
}

function cacheKey(baseUrl: string, provider: string, modelName: string): string {
  // NUL separates the parts so a value containing another separator character
  // cannot collide with a different triple. NUL is valid in none of them.
  return `${baseUrl}\0${provider}\0${modelName}`;
}

function toModelMax(entry: CacheEntry): ModelMax {
  return { modelMax: entry.modelMax, source: entry.source, probeError: entry.probeError };
}

function freshEntry(key: string, now: number): CacheEntry | undefined {
  const entry = cache.get(key);
  return entry && entry.expiresAt > now ? entry : undefined;
}

/**
 * Store a probe result. A probe never replaces a fresh learned limit: the 400
 * that taught it may have arrived while the probe was still in flight.
 */
function storeProbeResult(entry: CacheEntry, now: number): ModelMax {
  const key = cacheKey(entry.baseUrl, entry.provider, entry.model);
  const existing = freshEntry(key, now);
  if (existing?.kind === 'learned') {
    return toModelMax(existing);
  }
  cache.set(key, entry);
  return toModelMax(entry);
}

function sourceFor(ctx: LlmRequestContext, info: LlmModelInfo): ModelMaxSource {
  if (ctx.provider === 'openai-compatible') {
    return isLlamaCppModelInfo(info) ? 'llamacpp-loaded' : 'openai-models';
  }
  return 'static';
}

function describeProbeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function probeModelMax(
  ctx: LlmRequestContext,
  modelName: string,
  deps: CapProbeDeps
): Promise<ModelMax> {
  const base = {
    baseUrl: ctx.baseUrl,
    provider: providerKind(ctx.provider),
    model: modelName,
  };
  let timer: unknown;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = deps.setTimer(() => {
      reject(new Error(`model info probe timed out after ${deps.timeoutMs / 1000} s`));
    }, deps.timeoutMs);
  });
  try {
    const info = await Promise.race([deps.fetchModelInfo(ctx, modelName), timedOut]);
    const modelMax = getLlmModelContextLimit(info, ctx);
    return storeProbeResult(
      {
        ...base,
        kind: 'probed',
        modelMax,
        source: modelMax === null ? 'unknown' : sourceFor(ctx, info),
        probeError: null,
        expiresAt: deps.now() + CAP_SUCCESS_TTL_MS,
      },
      deps.now()
    );
  } catch (err) {
    return storeProbeResult(
      {
        ...base,
        kind: 'failed',
        modelMax: null,
        source: 'unknown',
        probeError: describeProbeError(err),
        expiresAt: deps.now() + CAP_FAILURE_TTL_MS,
      },
      deps.now()
    );
  } finally {
    deps.clearTimer(timer);
  }
}

/**
 * The maximum context window for `modelName` on the endpoint `ctx` points at.
 * Never throws: a probe that fails or times out resolves to an unknown maximum
 * with `probeError` set, and is not repeated for 60 s.
 */
export function resolveModelMax(
  ctx: LlmRequestContext,
  modelName: string,
  deps: Partial<CapProbeDeps> = {}
): Promise<ModelMax> {
  const resolvedDeps: CapProbeDeps = { ...defaultDeps, ...deps };
  const key = cacheKey(ctx.baseUrl, providerKind(ctx.provider), modelName);

  const cached = freshEntry(key, resolvedDeps.now());
  if (cached) {
    return Promise.resolve(toModelMax(cached));
  }

  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const probe = probeModelMax(ctx, modelName, resolvedDeps).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, probe);
  return probe;
}

/**
 * Record a limit a provider disclosed in a 400, so the next turn plans within
 * it and does not hit the same error. Replaces whatever the probe found.
 */
export function recordDiscoveredCap(
  target: { baseUrl: string; provider?: string | undefined },
  modelName: string,
  cap: number,
  now: number = Date.now()
): void {
  const provider = providerKind(target.provider);
  cache.set(cacheKey(target.baseUrl, provider, modelName), {
    kind: 'learned',
    modelMax: cap,
    source: 'learned',
    probeError: null,
    expiresAt: now + CAP_LEARNED_TTL_MS,
    baseUrl: target.baseUrl,
    provider,
    model: modelName,
  });
}

/** Test helper: drop every cached maximum and every probe in flight. */
export function clearCapCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Forget cached maximums so the next call probes again. Use it when the model,
 * the endpoint or the provider changes. A change of the context SETTING does
 * not need it: the maximum does not depend on the setting.
 *
 * - `baseUrl` and `modelName`: every entry for that pair, whichever provider.
 * - only `baseUrl`: every entry for that endpoint.
 * - neither: everything.
 */
export function invalidateCapCache(baseUrl?: string, modelName?: string): void {
  if (baseUrl === undefined && modelName === undefined) {
    cache.clear();
    inflight.clear();
    return;
  }
  for (const [key, entry] of cache) {
    if (
      (baseUrl === undefined || entry.baseUrl === baseUrl) &&
      (modelName === undefined || entry.model === modelName)
    ) {
      cache.delete(key);
      inflight.delete(key);
    }
  }
}
