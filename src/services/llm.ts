import type { LlmProvider } from '../types/chatConfig';
import type {
  ChatApiResponse,
  ChatParams,
  LlmAdapter,
  LlmModel,
  LlmModelInfo,
  LlmTurnStats,
  StreamChatParams,
} from './adapters/llmAdapter';

import { ollamaAdapter } from './adapters/ollamaAdapter';
import {
  clearApiKey as clearOpenAIApiKey,
  openaiCompatibleAdapter,
  setApiKey as setOpenAIApiKey,
} from './adapters/openaiCompatibleAdapter';
import { resolveVisionSupport, type VisionSupportState } from './visionCache';

let activeAdapter: LlmAdapter = ollamaAdapter;

export function getLlmAdapter(): LlmAdapter {
  return activeAdapter;
}

export function setLlmAdapter(adapter: LlmAdapter): void {
  activeAdapter = adapter;
}

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

export function configureLlmAdapter(provider?: LlmProvider): LlmAdapter {
  const adapter = selectLlmAdapter(provider);
  setLlmAdapter(adapter);
  return adapter;
}

/**
 * Configure the active adapter and its authentication key in one call.
 * This should be invoked once per request after loading config so the
 * correct provider and credentials are always in scope.
 */
export function configureLlmAdapterAndAuth(provider?: LlmProvider, apiKey?: string): LlmAdapter {
  const adapter = configureLlmAdapter(provider);
  if (provider === 'openai-compatible' && apiKey) {
    setOpenAIApiKey(apiKey);
  } else {
    clearOpenAIApiKey();
  }
  return adapter;
}

export function fetchLlmModels(baseUrl: string): Promise<LlmModel[]> {
  return activeAdapter.fetchModels(baseUrl);
}

export function fetchLlmModelInfo(baseUrl: string, modelName: string): Promise<LlmModelInfo> {
  return activeAdapter.fetchModelInfo(baseUrl, modelName);
}

export function getLlmModelContextLimit(modelInfo: LlmModelInfo): number | null {
  return activeAdapter.getModelContextLimit(modelInfo);
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
    return capabilities.has('vision') || capabilities.has('multimodal') || capabilities.has('image');
  }
  return false;
}

/**
 * Async, cache-aware vision-support resolution. The chat route uses
 * this in place of the sync `getLlmModelVisionSupport(info)` so the
 * `openai-compatible` provider — whose `/v1/models` has no standard
 * `capabilities` field — stops silently stripping image attachments
 * for the common vision-capable case. See `src/services/visionCache.ts`
 * for the resolution order (cache → probe → provider default).
 *
 * The injected probe is a thin wrapper around the existing
 * `info.capabilities` heuristic; for openai-compatible the probe
 * returns `false` (no capabilities), so the resolver falls through
 * to the optimistic default. For ollama the probe reads
 * `info.capabilities` directly and the resolver caches its result.
 *
 * The `provider` argument comes from the active `Config.provider`
 * and selects the optimistic default (`'supported'` for
 * openai-compatible, `'unsupported'` for ollama).
 */
export async function getLlmModelVisionSupportAsync(
  baseUrl: string,
  modelName: string,
  provider: LlmProvider,
  info: LlmModelInfo
): Promise<{ visionSupported: boolean; state: VisionSupportState }> {
  const resolved = await resolveVisionSupport(baseUrl, modelName, provider, () =>
    getLlmModelVisionSupport(info)
  );
  return {
    visionSupported: resolved.state === 'supported',
    state: resolved.state,
  };
}

export function sendLlmChat(
  baseUrl: string,
  params: ChatParams,
  onChunk?: (chunk: ChatApiResponse) => void,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<ChatApiResponse> {
  return activeAdapter.sendChat(baseUrl, params, onChunk, timeoutMs, signal);
}

export function sendLlmChatStream(
  baseUrl: string,
  params: StreamChatParams
): AsyncGenerator<ChatApiResponse> {
  return activeAdapter.sendChatStream(baseUrl, params);
}

export function getLlmApiErrorMessage(error: unknown): Promise<string> {
  return activeAdapter.getApiErrorMessage(error);
}

export function getLlmTurnStats(response: ChatApiResponse): LlmTurnStats | null {
  return activeAdapter.getTurnStats(response);
}

export function fetchLlmRunningModelContextLength(
  baseUrl: string,
  modelName: string
): Promise<number | null> {
  if (!activeAdapter.fetchRunningModelContextLength) {
    return Promise.resolve(null);
  }
  return activeAdapter.fetchRunningModelContextLength(baseUrl, modelName);
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
export {
  clearVisionCache,
  invalidateVisionCache,
  recordDiscoveredNonVision,
  resolveVisionSupport,
  type ResolvedVisionSupport,
  type VisionSupportState,
} from './visionCache';
export { parseVisionUnsupportedFromError } from './llmContextLimit';
