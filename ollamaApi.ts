import axios from 'axios';
import { createInterface } from 'readline';
import type { ToolCallArguments } from './tools.js';

export interface OllamaModelDetails {
    parent_model: string;
    format: string;
    family: string;
    families: string[] | null;
    parameter_size: string;
    quantization_level: string;
}

export interface OllamaModel {
    name: string;
    model: string;
    modified_at: string;
    size: number;
    digest: string;
    details: OllamaModelDetails;
}

interface TagsResponse {
    models: OllamaModel[];
}

export interface OllamaToolCall {
    function: {
        name: string;
        arguments: ToolCallArguments;
    };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: OllamaToolCall[];
}

export interface ChatApiResponse {
    model: string;
    created_at: string;
    message: ChatMessage;
    done: boolean;
    done_reason?: string;
}

export async function validateOllamaConnection(baseUrl: string, timeoutMs: number = 2000): Promise<void> {
    await axios.get<TagsResponse>(`${baseUrl}/api/tags`, { timeout: timeoutMs });
}

export async function fetchOllamaModels(baseUrl: string): Promise<OllamaModel[]> {
    const response = await axios.get<TagsResponse>(`${baseUrl}/api/tags`);
    return response.data.models || [];
}

export async function sendOllamaChat(
    baseUrl: string,
    params: {
        model: string;
        messages: ChatMessage[];
        tools: unknown[];
        numCtx: number;
    },
): Promise<ChatApiResponse> {
    const response = await axios.post<ChatApiResponse>(`${baseUrl}/api/chat`, {
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        stream: false,
        options: {
            num_ctx: params.numCtx,
        },
    });

    return response.data;
}

export async function* sendOllamaChatStream(
    baseUrl: string,
    params: {
        model: string;
        messages: ChatMessage[];
        tools: unknown[];
        numCtx: number;
        signal?: AbortSignal;
    },
): AsyncGenerator<ChatApiResponse> {
    const requestConfig: { responseType: 'stream'; signal?: AbortSignal } = {
        responseType: 'stream',
    };
    if (params.signal) {
        requestConfig.signal = params.signal;
    }

    const response = await axios.post<NodeJS.ReadableStream>(`${baseUrl}/api/chat`, {
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        stream: true,
        options: {
            num_ctx: params.numCtx,
        },
    }, requestConfig);

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

export async function getOllamaApiErrorMessage(error: unknown): Promise<string> {
    if (axios.isAxiosError(error)) {
        if (error.response?.data) {
            const data = error.response.data;

            // If it's a stream (IncomingMessage in Node), try to read it
            if (typeof data.on === 'function') {
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
            } else if (typeof data === 'object' && data.error) {
                // If it's already an object (non-streaming requests)
                return `${error.message}: ${data.error}`;
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
