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

export function validateLlmConnection(baseUrl: string, timeoutMs?: number): Promise<void> {
  return activeAdapter.validateConnection(baseUrl, timeoutMs);
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
  if (Array.isArray(info.capabilities)) {
    const capabilities = new Set(info.capabilities.map(String));
    return capabilities.has('vision') || capabilities.has('multimodal') || capabilities.has('image');
  }
  return false;
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

export function fetchLlmRunningModelVram(baseUrl: string, modelName: string): Promise<number | null> {
  if (!activeAdapter.fetchRunningModelVram) {
    return Promise.resolve(null);
  }
  return activeAdapter.fetchRunningModelVram(baseUrl, modelName);
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
