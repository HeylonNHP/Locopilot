import type { ToolCallArguments } from '../../tools/tools';

export interface ToolCall {
    id: string;
    function: {
        name: string;
        arguments: ToolCallArguments;
    };
}

export interface ToolDefinition {
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
    thinking?: string;
    tool_calls?: [ToolCall, ...ToolCall[]];
    /** OpenAI-compatible: identifies which tool call this result answers. */
    tool_call_id?: string;
    /** Base64-encoded images for multimodal/vision models. */
    images?: string[];
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

export interface ChatParams {
    model: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    numCtx: number;
    think?: boolean;
    /**
     * When false, omit image attachments from the outgoing prompt payload.
     * Undefined means unknown and preserves any existing image data.
     */
    visionSupported?: boolean;
    options?: Record<string, unknown>;
    signal?: AbortSignal;
    format?: string | Record<string, unknown>;
}

export interface StreamChatParams extends ChatParams {
    signal?: AbortSignal;
    timeoutMs?: number | undefined;
}

export interface LlmModelDetails {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[] | null;
    parameter_size?: string;
    quantization_level?: string;
    [key: string]: unknown;
}

export interface LlmModelInfo {
    modelfile?: string;
    parameters?: string;
    template?: string;
    system?: string;
    model_info?: Record<string, unknown>;
    details?: LlmModelDetails;
    messages?: ChatMessage[];
    capabilities?: string[];
    [key: string]: unknown;
}

export interface LlmModel {
    name: string;
    model?: string;
    modified_at?: string;
    size?: number;
    digest?: string;
    details?: LlmModelDetails;
    [key: string]: unknown;
}

export interface LlmTurnStats {
    promptEvalCount: number;
    evalCount: number;
    totalDuration?: number;
    promptEvalDuration?: number;
    evalDuration?: number;
    loadDuration?: number;
}

export interface LlmAdapter {
    readonly id: string;
    validateConnection(baseUrl: string, timeoutMs?: number): Promise<void>;
    fetchModels(baseUrl: string): Promise<LlmModel[]>;
    fetchModelInfo(baseUrl: string, modelName: string): Promise<LlmModelInfo>;
    getModelContextLimit(modelInfo: LlmModelInfo): number | null;
    sendChat(
        baseUrl: string,
        params: ChatParams,
        onChunk?: (chunk: ChatApiResponse) => void,
        timeoutMs?: number,
        signal?: AbortSignal,
    ): Promise<ChatApiResponse>;
    sendChatStream(baseUrl: string, params: StreamChatParams): AsyncGenerator<ChatApiResponse>;
    getApiErrorMessage(error: unknown): Promise<string>;
    getTurnStats(response: ChatApiResponse): LlmTurnStats | null;
    fetchRunningModelVram?(baseUrl: string, modelName: string): Promise<number | null>;
}