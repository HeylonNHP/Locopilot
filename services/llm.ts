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

let activeAdapter: LlmAdapter = ollamaAdapter;

export function getLlmAdapter(): LlmAdapter {
    return activeAdapter;
}

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