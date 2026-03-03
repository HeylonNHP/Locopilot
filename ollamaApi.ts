import axios from 'axios';
import { createInterface } from 'readline';
import { Readable } from 'stream';
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

export interface OllamaToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: [OllamaToolCall, ...OllamaToolCall[]];
}

export interface ChatApiResponse {
    model: string;
    created_at: string;
    message: ChatMessage;
    done: boolean;
    done_reason?: string;
    total_duration?: number;
    load_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    eval_count?: number;
    eval_duration?: number;
}

interface ChatParams {
    model: string;
    messages: ChatMessage[];
    tools: OllamaToolDefinition[];
    numCtx: number;
    options?: Record<string, unknown>;
}

export interface StreamChatParams extends ChatParams {
    signal?: AbortSignal;
}

function buildChatPayload(params: ChatParams, stream: boolean) {
    return {
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        stream,
        options: {
            num_ctx: params.numCtx,
            ...(params.options ?? {}),
        },
    };
}

export interface OllamaTurnStats {
    promptEvalCount: number;
    evalCount: number;
    totalDuration?: number;
    promptEvalDuration?: number;
    evalDuration?: number;
    loadDuration?: number;
}

export function getOllamaTurnStats(response: ChatApiResponse): OllamaTurnStats | null {
    if (!Number.isFinite(response.prompt_eval_count) || !Number.isFinite(response.eval_count)) {
        return null;
    }

    const stats: OllamaTurnStats = {
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

export async function validateOllamaConnection(baseUrl: string, timeoutMs: number = 2000): Promise<void> {
    await axios.get<TagsResponse>(`${baseUrl}/api/tags`, { timeout: timeoutMs });
}

export async function fetchOllamaModels(baseUrl: string): Promise<OllamaModel[]> {
    const response = await axios.get<TagsResponse>(`${baseUrl}/api/tags`);
    return response.data.models || [];
}

export async function sendOllamaChat(
    baseUrl: string,
    params: ChatParams,
): Promise<ChatApiResponse> {
    const response = await axios.post<ChatApiResponse>(
        `${baseUrl}/api/chat`,
        buildChatPayload(params, false),
    );

    return response.data;
}

export async function* sendOllamaChatStream(
    baseUrl: string,
    params: StreamChatParams,
): AsyncGenerator<ChatApiResponse> {
    const requestConfig: { responseType: 'stream'; signal?: AbortSignal } = {
        responseType: 'stream',
    };
    if (params.signal) {
        requestConfig.signal = params.signal;
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

export async function getOllamaApiErrorMessage(error: unknown): Promise<string> {
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
