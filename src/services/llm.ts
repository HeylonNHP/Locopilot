import type { LlmProvider } from '@/types/chatConfig';

import type {
  ChatApiResponse,
  ChatParams,
  LlmAdapter,
  LlmModel,
  LlmModelInfo,
  LlmRequestContext,
  LlmTurnStats,
  StreamChatParams,
} from './adapters/llmAdapter';

import { ollamaAdapter } from './adapters/ollamaAdapter';
import { openaiCompatibleAdapter } from './adapters/openaiCompatibleAdapter';
import {
  resolveSamplingParamSupportMap,
  type SamplingParamName,
  type SamplingParamSupportMap,
} from './samplingParamsCache';
import { resolveVisionSupport, type VisionSupportState } from './visionCache';

export type { LlmRequestContext } from './adapters/llmAdapter';

/**
 * Select the right adapter for a given provider. Pure function — no module
 * state mutation, so two concurrent requests with different providers each
 * receive the correct adapter without racing on a singleton.
 */
export function selectLlmAdapter(provider?: LlmProvider): LlmAdapter {
  switch (provider) {
    case 'openai-compatible': {
      return openaiCompatibleAdapter;
    }
    default: {
      return ollamaAdapter;
    }
  }
}

/**
 * Build the per-request LLM context. Callers should construct one of these
 * per HTTP request (or per parallel sub-task) and pass it through every LLM
 * call in that request's scope. The context is the only thing that ties an
 * outbound LLM call to its provider, baseUrl, and apiKey — there is no
 * module-level adapter or client anymore.
 */
export function buildLlmRequestContext(options: {
  provider?: LlmProvider;
  baseUrl: string;
  apiKey?: string;
  requestId?: string;
}): LlmRequestContext {
  const ctx: LlmRequestContext = {
    baseUrl: options.baseUrl,
  };
  if (options.provider) {
    ctx.provider = options.provider;
  }
  if (options.apiKey && options.apiKey.length > 0) {
    ctx.apiKey = options.apiKey;
  }
  if (options.requestId) {
    ctx.requestId = options.requestId;
  }
  return ctx;
}

/**
 * Convenience: look up the right adapter for a given context and return it.
 * The adapter object is stateless — the per-request data lives on the
 * context, so concurrent requests with different providers still each see
 * the correct adapter without any singleton to race on.
 */
function adapterForContext(ctx: LlmRequestContext): LlmAdapter {
  return selectLlmAdapter(ctx.provider);
}

export function fetchLlmModels(ctx: LlmRequestContext): Promise<LlmModel[]> {
  return adapterForContext(ctx).fetchModels(ctx);
}

export function fetchLlmModelInfo(
  ctx: LlmRequestContext,
  modelName: string
): Promise<LlmModelInfo> {
  return adapterForContext(ctx).fetchModelInfo(ctx, modelName);
}

export function getLlmModelContextLimit(modelInfo: LlmModelInfo): number | null {
  return ollamaAdapter.getModelContextLimit(modelInfo);
}

export function getLlmModelVisionSupport(info: LlmModelInfo): boolean {
  // Defensive: a null/undefined info payload should not throw, even
  // though the contract says `LlmModelInfo`. The legacy sync
  // heuristic is also called from the /api/models projection in a
  // context where the info is best-effort.
  if (!info || typeof info !== 'object') {
    return false;
  }
  if (Array.isArray(info.capabilities)) {
    const capabilities = new Set(info.capabilities.map(String));
    return (
      capabilities.has('vision') || capabilities.has('multimodal') || capabilities.has('image')
    );
  }
  return false;
}

/**
 * Async, cache-aware vision-support resolution. The chat route and model-list
 * route use this common facade so both paths share the same provider-aware
 * cache semantics. `info` is optional because model metadata is best-effort.
 * For Ollama, a real `/api/show` capabilities probe can refresh a weak
 * default cache entry; a runtime-discovered rejection remains authoritative.
 * For openai-compatible providers, generic `/v1/models` metadata is ignored
 * and the optimistic default is retained.
 *
 * The `provider` argument comes from the active `Config.provider`
 * and selects the optimistic default (`'supported'` for
 * openai-compatible, `'unsupported'` for ollama).
 */
export async function getLlmModelVisionSupportAsync(
  baseUrl: string,
  modelName: string,
  provider: LlmProvider,
  info?: LlmModelInfo
): Promise<{ visionSupported: boolean; state: VisionSupportState }> {
  const resolved = await resolveVisionSupport(
    baseUrl,
    modelName,
    provider,
    info ? () => getLlmModelVisionSupport(info) : undefined
  );
  return {
    visionSupported: resolved.state === 'supported',
    state: resolved.state,
  };
}

/**
 * Async, cache-aware per-parameter sampling-support resolution. The chat
 * route calls this once per turn and feeds the result into
 * `applySupportedSamplingParams` (see
 * `src/services/adapters/openaiCompatibleAdapter.ts`). The optional
 * `probe` is supplied by the adapter to consult the upstream's
 * `supported_parameters` list (OpenRouter exposes this; most other
 * openai-compatible providers do not).
 *
 * Returns a map keyed by the standard sampling-param registry; the
 * adapter materializes each field as long as the verdict is
 * `'supported'` (or the entry is missing, which the cache treats as
 * the optimistic default).
 */
export async function getLlmModelSamplingParamSupportAsync(
  baseUrl: string,
  modelName: string,
  provider: LlmProvider,
  probe?: () => SamplingParamSupportMap | Promise<SamplingParamSupportMap>
): Promise<Record<SamplingParamName, { state: 'supported' | 'unsupported'; source: string }>> {
  return resolveSamplingParamSupportMap(baseUrl, modelName, provider, probe);
}

export function sendLlmChat(
  ctx: LlmRequestContext,
  params: ChatParams,
  onChunk?: (chunk: ChatApiResponse) => void,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<ChatApiResponse> {
  return adapterForContext(ctx).sendChat(ctx, params, onChunk, timeoutMs, signal);
}

export function sendLlmChatStream(
  ctx: LlmRequestContext,
  params: StreamChatParams
): AsyncGenerator<ChatApiResponse> {
  return adapterForContext(ctx).sendChatStream(ctx, params);
}

export function getLlmApiErrorMessage(ctx: LlmRequestContext, error: unknown): Promise<string> {
  return adapterForContext(ctx).getApiErrorMessage(error);
}

export function getLlmTurnStats(
  ctx: LlmRequestContext,
  response: ChatApiResponse
): LlmTurnStats | null {
  return adapterForContext(ctx).getTurnStats(response);
}

export function fetchLlmRunningModelContextLength(
  ctx: LlmRequestContext,
  modelName: string
): Promise<number | null> {
  const adapter = adapterForContext(ctx);
  if (!adapter.fetchRunningModelContextLength) {
    return Promise.resolve(null);
  }
  return adapter.fetchRunningModelContextLength(ctx, modelName);
}

export type { LlmTurnStats, StreamChatParams } from './adapters/llmAdapter';
export {
  type ChatApiResponse,
  type ChatMessage,
  type ChatParams,
  type LlmAdapter,
  type LlmModel,
  type LlmModelInfo,
  type PersistedChatMessage,
  type SubagentLogMessage,
  type ToolCall,
  type ToolDefinition,
} from './adapters/llmAdapter';
// Re-export the vision-cache surface and the 400-message parser so
// callers can import the full vision-capability stack from a single
// entry point (mirrors the `capResolver` + `llmContextLimit` pattern
// that the chat route uses). The actual implementations live in
// `visionCache.ts` and `llmContextLimit.ts`.
export { parseUnsupportedParamFromError, parseVisionUnsupportedFromError } from './llmContextLimit';
export {
  clearSamplingParamCache,
  invalidateSamplingParamCache,
  recordDiscoveredUnsupportedParam,
  type SamplingParamName,
  type SamplingParamSupportMap,
  type SamplingParamSupportState,
} from './samplingParamsCache';
export {
  clearVisionCache,
  invalidateVisionCache,
  recordDiscoveredNonVision,
  type ResolvedVisionSupport,
  resolveVisionSupport,
  type VisionSupportState,
} from './visionCache';
