import axios from 'axios';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import type {
    ChatApiResponse,
    ChatMessage,
    ChatParams,
    LlmAdapter,
    LlmModel,
    LlmModelInfo,
    LlmTurnStats,
    StreamChatParams,
} from './llmAdapter.js';

interface TagsResponse {
    models: LlmModel[];
}

function buildChatPayload(params: ChatParams, stream: boolean) {
    return {
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        stream,
        think: params.think,
        options: {
            num_ctx: params.numCtx,
            ...(params.options ?? {}),
        },
    };
}

function getOllamaTurnStats(response: ChatApiResponse): LlmTurnStats | null {
    if (!Number.isFinite(response.prompt_eval_count) || !Number.isFinite(response.eval_count)) {
        return null;
    }

    const stats: LlmTurnStats = {
        promptEvalCount: response.prompt_eval_count ?? 0,
        evalCount: response.eval_count ?? 0,
    };

    const totalDuration = response.total_duration;
    if (typeof totalDuration === 'number') {
        stats.totalDuration = totalDuration;
    }
    const promptEvalDuration = response.prompt_eval_duration;
    if (typeof promptEvalDuration === 'number') {
        stats.promptEvalDuration = promptEvalDuration;
    }
    const evalDuration = response.eval_duration;
    if (typeof evalDuration === 'number') {
        stats.evalDuration = evalDuration;
    }
    const loadDuration = response.load_duration;
    if (typeof loadDuration === 'number') {
        stats.loadDuration = loadDuration;
    }

    return stats;
}

async function validateOllamaConnection(baseUrl: string, timeoutMs: number = 2000): Promise<void> {
    await axios.get<TagsResponse>(`${baseUrl}/api/tags`, { timeout: timeoutMs });
}

async function fetchOllamaModels(baseUrl: string): Promise<LlmModel[]> {
    const response = await axios.get<TagsResponse>(`${baseUrl}/api/tags`);
    return response.data.models || [];
}

async function fetchOllamaModelInfo(baseUrl: string, modelName: string): Promise<LlmModelInfo> {
    const response = await axios.post<LlmModelInfo>(`${baseUrl}/api/show`, { name: modelName });
    return response.data;
}

async function sendOllamaChat(
    baseUrl: string,
    params: ChatParams,
    onChunk?: (chunk: ChatApiResponse) => void,
    timeoutMs?: number | undefined,
): Promise<ChatApiResponse> {
    const config: any = {};
    if (timeoutMs !== undefined) config.timeout = timeoutMs;

    if (onChunk) {
        // Use streaming internally to provide progress but return full response
        const streamParams: StreamChatParams = { ...params };
        let fullMessage: ChatMessage = { role: 'assistant', content: '' };
        let lastChunk: ChatApiResponse | null = null;

        for await (const chunk of sendOllamaChatStream(baseUrl, streamParams)) {
            if (chunk.message?.content) {
                fullMessage.content += chunk.message.content;
            }
            if (chunk.message?.thinking) {
                fullMessage.thinking = `${fullMessage.thinking ?? ''}${chunk.message.thinking}`;
            }
            if (chunk.message?.tool_calls) {
                fullMessage.tool_calls = chunk.message.tool_calls;
            }
            lastChunk = chunk;
            onChunk(chunk);
        }

        if (!lastChunk) throw new Error('No response from Ollama');
        return {
            ...lastChunk,
            message: fullMessage,
        };
    }

    const response = await axios.post<ChatApiResponse>(
        `${baseUrl}/api/chat`,
        buildChatPayload(params, false),
        config
    );

    return response.data;
}

async function* sendOllamaChatStream(
    baseUrl: string,
    params: StreamChatParams,
): AsyncGenerator<ChatApiResponse> {
    const requestConfig: any = {
        responseType: 'stream',
    };
    if (params.signal) {
        requestConfig.signal = params.signal;
    }
    if (params.timeoutMs !== undefined) {
        requestConfig.timeout = params.timeoutMs;
    }

    const response = await axios.post<NodeJS.ReadableStream>(
        `${baseUrl}/api/chat`,
        buildChatPayload(params, true),
        requestConfig,
    );

    const lineReader = createInterface({
        input: response.data as NodeJS.ReadableStream,
        crlfDelay: Infinity,
    });

    try {
        for await (const line of lineReader) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
                yield JSON.parse(trimmed) as ChatApiResponse;
            } catch {
                continue;
            }
        }
    } finally {
        lineReader.close();
    }
}

async function getOllamaApiErrorMessage(error: unknown): Promise<string> {
    if (axios.isAxiosError(error)) {
        if (error.response?.data) {
            const data = error.response.data;

            // If it's a stream, try to read it
            if (data instanceof Readable) {
                try {
                    const chunks: Buffer[] = [];
                    for await (const chunk of data) {
                        chunks.push(chunk);
                    }
                    const body = Buffer.concat(chunks).toString();
                    try {
                        const json = JSON.parse(body);
                        if (json.error) return `${error.message}: ${json.error}`;
                    } catch {
                        if (body.trim()) return `${error.message}: ${body.trim()}`;
                    }
                } catch {
                    // Fallback to error.message if reading stream fails
                }
            } else if (typeof data === 'object' && data && 'error' in data) {
                // If it's already an object (non-streaming requests)
                return `${error.message}: ${String((data as { error: unknown }).error)}`;
            } else if (typeof data === 'string' && data.trim()) {
                return `${error.message}: ${data.trim()}`;
            }
        }
        return error.message;
    }

    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

export const ollamaAdapter: LlmAdapter = {
    id: 'ollama',
    validateConnection: validateOllamaConnection,
    fetchModels: fetchOllamaModels,
    fetchModelInfo: fetchOllamaModelInfo,
    sendChat: sendOllamaChat,
    sendChatStream: sendOllamaChatStream,
    getApiErrorMessage: getOllamaApiErrorMessage,
    getTurnStats: getOllamaTurnStats,
};
