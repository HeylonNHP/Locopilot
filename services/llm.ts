import { ollamaAdapter } from './adapters/ollamaAdapter';
import type {
    ChatApiResponse,
    ChatMessage,
    ChatParams,
    LlmAdapter,
    LlmModel,
    LlmModelInfo,
    LlmTurnStats,
    StreamChatParams,
    ToolCall,
    ToolDefinition,
} from './adapters/llmAdapter';

/**
 * The active adapter is a module-level singleton. Changing it at runtime
 * (via setLlmAdapter) while concurrent HTTP requests are in-flight could
 * cause those requests to unexpectedly switch to a different LLM backend
 * mid-stream. Currently the adapter is set once at startup and never
 * changed, so this is only a latent risk for multi-WebUI concurrency.
 */
let activeAdapter: LlmAdapter = ollamaAdapter;

export function getLlmAdapter(): LlmAdapter {
    return activeAdapter;
}

/**
 * Swap the active LLM adapter at runtime.
 *
 * NOTE: This is not thread-safe — do not call while HTTP requests are
 * in-flight, as they would see the new adapter mid-stream. Currently
 * only called once at startup.
 */
export function setLlmAdapter(adapter: LlmAdapter): void {
    activeAdapter = adapter;
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
        const capabilities = info.capabilities.map(String);
        return capabilities.includes('vision') || capabilities.includes('multimodal') || capabilities.includes('image');
    }
    return false;
}

export function sendLlmChat(
    baseUrl: string,
    params: ChatParams,
    onChunk?: (chunk: ChatApiResponse) => void,
    timeoutMs?: number,
): Promise<ChatApiResponse> {
    return activeAdapter.sendChat(baseUrl, params, onChunk, timeoutMs);
}

export function sendLlmChatStream(
    baseUrl: string,
    params: StreamChatParams,
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

export type {
    ChatApiResponse,
    ChatMessage,
    ChatParams,
    LlmAdapter,
    LlmModel,
    LlmModelInfo,
    LlmTurnStats,
    StreamChatParams,
    ToolCall,
    ToolDefinition,
};