import axios from 'axios';
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

export function getOllamaApiErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
        return error.message;
    }

    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}
