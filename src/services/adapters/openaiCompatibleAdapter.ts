import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { writeFile } from 'node:fs/promises';

import type {
  ChatApiResponse,
  ChatMessage,
  ChatParams,
  LlmAdapter,
  LlmModel,
  LlmModelInfo,
  StreamChatParams,
  ToolCall,
} from './llmAdapter';

// ── Auth support ──────────────────────────────────────────────────────────────
// The adapter interface doesn't pass an apiKey parameter, so we use a
// module-level axios instance that the caller can configure via setApiKey().
let client: AxiosInstance = axios;

/**
 * Configure the API key used for all OpenAI-compatible requests.
 * Call this once at startup (e.g. from configureLlmAdapter) before
 * any chat requests are made.
 */
export function setApiKey(apiKey: string): void {
  client = axios.create({
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

/**
 * Reset the client to its default unauthenticated state (useful when
 * switching back to Ollama or to a provider that doesn't need a key).
 */
export function clearApiKey(): void {
  client = axios;
}

// ── OpenAI API types (concrete, matching the official spec) ───────────────────

/** A message as sent to the OpenAI Chat Completions API. */
type OpenAIMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'tool'; content: string; tool_call_id: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };

/** A tool definition as sent to the OpenAI API. */
interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

/** The request body for POST /v1/chat/completions. */
interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream: boolean;
  tools?: OpenAITool[];
  reasoning_effort?: 'low' | 'medium' | 'high';
  response_format?: string | Record<string, unknown>;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  logit_bias?: Record<number, number>;
  user?: string;
  /** Provider-specific extra body (e.g. vLLM extras). */
  extra_body?: Record<string, unknown>;
}

/** A tool call in a non-streaming response message. */
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Usage metadata in a response. */
interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

/** The non-streaming response from POST /v1/chat/completions. */
interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: Array<{
    index: number;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage?: OpenAIUsage;
}

/** A tool call delta in a streaming chunk. */
interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** A single SSE streaming chunk from POST /v1/chat/completions with stream=true. */
interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: Array<{
    index: number;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
    delta: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** The models list response from GET /v1/models. */
interface OpenAIListModelsResponse {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }>;
}

/** The error response body from the OpenAI API. */
interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripImagesFromMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.images || message.images.length === 0) {
      return message;
    }
    const { images: _images, ...rest } = message;
    return rest;
  });
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;

    // OpenAI requires that a 'tool' message follows an assistant message
    // that has tool_calls. If the preceding message is not such an assistant
    // (e.g. the assistant's tool-call message was lost from history),
    // convert the orphaned tool message to a 'user' message so the API
    // doesn't reject the request with a 400.
    if (message.role === 'tool') {
      const prev = i > 0 ? messages[i - 1] : undefined;
      const prevHasToolCalls =
        prev?.role === 'assistant' &&
        !!prev.tool_calls &&
        prev.tool_calls.length > 0;
      if (!prevHasToolCalls) {
        // Orphaned tool message — convert to user so it's still sent as context.
        result.push({
          role: 'user',
          content: message.content || '',
        });
        continue;
      }
    }

    // OpenAI requires content: null for assistant messages that only have tool_calls.
    const hasToolCalls = !!message.tool_calls && message.tool_calls.length > 0;
    const content: string | null =
      hasToolCalls && !message.content?.trim() ? null : message.content;

    const base: OpenAIMessage = {
      role: message.role,
      content,
    } as OpenAIMessage;

    if (message.tool_call_id) {
      (base as { tool_call_id: string }).tool_call_id = message.tool_call_id;
    } else if (message.role === 'tool') {
      // tool_call_id is not persisted in the session database, so it may
      // be missing when loading history. Use the id from the preceding
      // assistant message's tool_calls as a fallback.
      const prev = i > 0 ? messages[i - 1] : undefined;
      const prevToolCalls = prev?.role === 'assistant' ? prev.tool_calls : undefined;
      const fallbackId = prevToolCalls?.[0]?.id || 'call_fallback_0';
      (base as { tool_call_id: string }).tool_call_id = fallbackId;
    }
    if (message.tool_calls) {
      (base as { tool_calls: OpenAIToolCall[] }).tool_calls = message.tool_calls.map(
        (toolCall, idx) => ({
          // OpenAI requires tool_calls[].id — generate a fallback if the
          // stored message is missing one (e.g. older history entries).
          id: toolCall.id || `call_fallback_${idx}`,
          type: 'function' as const,
          function: {
            name: toolCall.function.name,
            arguments: JSON.stringify(toolCall.function.arguments),
          },
        }),
      );
    }

    result.push(base);
  }

  return result;
}

/**
 * Recursively strip `description` fields from a tool parameter schema object.
 * Some providers (e.g. Airia) reject description fields inside nested
 * items.properties, even though they are valid JSON Schema.
 */
function stripDescriptions(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripDescriptions);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === 'description') continue; // strip description fields
      result[key] = stripDescriptions(value);
    }
    return result;
  }
  return obj;
}

/**
 * Strip description fields from all tool definitions in the array.
 */
function stripToolDescriptions(tools: OpenAITool[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: tool.type,
    function: {
      name: tool.function.name,
      description: tool.function.description ?? '',
      parameters: stripDescriptions(tool.function.parameters) as Record<string, unknown>,
      ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict }),
    },
  }));
}

/**
 * Build the request payload for /v1/chat/completions.
 * Only includes fields that are present and meaningful.
 */
function buildChatPayload(params: ChatParams, stream: boolean): OpenAIChatCompletionRequest {
  const messages =
    params.visionSupported === false ? stripImagesFromMessages(params.messages) : params.messages;

  const payload: OpenAIChatCompletionRequest = {
    model: params.model,
    messages: toOpenAIMessages(messages),
    stream,
  };

  // Only include tools when there are actually tools to send.
  if (params.tools && params.tools.length > 0) {
    // Strip description fields from nested schema objects — some providers
    // (e.g. Airia) reject descriptions inside items.properties.
    payload.tools = stripToolDescriptions(params.tools as OpenAITool[]);
  }

  // Standard generation parameters — passed through from params.options
  // so the caller can set them without changing the adapter interface.
  if (params.options) {
    if (params.options.max_tokens !== undefined) {
      payload.max_tokens = params.options.max_tokens as number;
    }
    if (params.options.max_completion_tokens !== undefined) {
      payload.max_completion_tokens = params.options.max_completion_tokens as number;
    }
    if (params.options.temperature !== undefined) {
      payload.temperature = params.options.temperature as number;
    }
    if (params.options.top_p !== undefined) {
      payload.top_p = params.options.top_p as number;
    }
    if (params.options.stop !== undefined) {
      payload.stop = params.options.stop as string | string[];
    }
    if (params.options.seed !== undefined) {
      payload.seed = params.options.seed as number;
    }
    if (params.options.frequency_penalty !== undefined) {
      payload.frequency_penalty = params.options.frequency_penalty as number;
    }
    if (params.options.presence_penalty !== undefined) {
      payload.presence_penalty = params.options.presence_penalty as number;
    }
    if (params.options.logit_bias !== undefined) {
      payload.logit_bias = params.options.logit_bias as Record<number, number>;
    }
    if (params.options.user !== undefined) {
      payload.user = params.options.user as string;
    }
  }

  // OpenAI-compatible reasoning effort (e.g. for o-series models).
  // Skip when tools are present — most providers reject reasoning_effort
  // alongside function tools (Airia returns 400 for this combination).
  if (params.think !== undefined && (!params.tools || params.tools.length === 0)) {
    payload.reasoning_effort = params.think ? 'medium' : 'low';
  }

  // Defensive: some callers set reasoning parameters independently of tools.
  // If tools are present, drop reasoning_effort to avoid provider 400s.
  if (payload.reasoning_effort !== undefined && payload.tools && payload.tools.length > 0) {
    delete payload.reasoning_effort;
  }

  // Response format (JSON mode, structured output, etc.).
  if (params.format !== undefined) {
    payload.response_format = params.format;
  }

  // Stream options — request usage data in the final streaming chunk.
  if (stream) {
    payload.stream_options = { include_usage: true };
  }

  // Provider-specific extra body (e.g. vLLM, Ollama extras).
  if (params.options?.extra_body) {
    payload.extra_body = params.options.extra_body as Record<string, unknown>;
  }

  return payload;
}

/**
 * Convert an OpenAI streaming delta tool_calls array into the app's
 * ToolCall format. Because OpenAI sends tool calls incrementally
 * across chunks (identified by `index`), we merge partial data into
 * an accumulator map and return the completed calls when done.
 */
interface PartialToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

function finalizeToolCalls(accumulator: Map<number, PartialToolCall>): ToolCall[] | undefined {
  if (accumulator.size === 0) return undefined;

  const calls: ToolCall[] = [];

  // Sort by index to maintain the order the model intended.
  const sortedIndices = [...accumulator.keys()].sort((a, b) => a - b);

  for (const index of sortedIndices) {
    const partial = accumulator.get(index)!;
    if (!partial.id || !partial.name) continue;

    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(partial.arguments) as Record<string, unknown>;
    } catch {
      // If the arguments aren't valid JSON yet (shouldn't happen on the
      // final chunk, but be safe), use an empty object.
      parsedArgs = {};
    }

    calls.push({
      id: partial.id,
      function: {
        name: partial.name,
        arguments: parsedArgs,
      },
    });
  }

  return calls.length > 0 ? (calls as unknown as [ToolCall, ...ToolCall[]]) : undefined;
}

function toChatApiResponse(response: OpenAIChatCompletionResponse): ChatApiResponse {
  const choice = response.choices[0];
  const content = choice?.message.content ?? '';
  const toolCalls: ToolCall[] | undefined = choice?.message.tool_calls?.map((toolCall) => ({
    id: toolCall.id,
    function: {
      name: toolCall.function.name,
      arguments: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
    },
  }));

  const result: ChatApiResponse = {
    model: response.model,
    created_at: new Date(
      (response.created ?? Math.floor(Date.now() / 1000)) * 1000,
    ).toISOString(),
    done: true,
    ...(choice?.finish_reason ? { done_reason: choice.finish_reason } : {}),
    message: {
      role: 'assistant',
      content,
      ...(toolCalls && toolCalls.length > 0
        ? { tool_calls: toolCalls as unknown as [ToolCall, ...ToolCall[]] }
        : {}),
    },
    ...(response.usage?.prompt_tokens === undefined
      ? {}
      : { prompt_eval_count: response.usage.prompt_tokens }),
    ...(response.usage?.completion_tokens === undefined
      ? {}
      : { eval_count: response.usage.completion_tokens }),
  };

  return result;
}

// ── API methods ──────────────────────────────────────────────────────────────

async function validateOpenAICompatibleConnection(
  baseUrl: string,
  timeoutMs: number = 2000,
): Promise<void> {
  await client.get(`${baseUrl.replace(/\/+$/, '')}/v1/models`, { timeout: timeoutMs });
}

async function fetchOpenAICompatibleModels(baseUrl: string): Promise<LlmModel[]> {
  const response = await client.get<OpenAIListModelsResponse>(
    `${baseUrl.replace(/\/+$/, '')}/v1/models`,
  );
  return (response.data.data ?? []).map((model) => ({
    name: model.id,
    model: model.id,
    details: {
      ...(model.owned_by ? { parent_model: model.owned_by } : {}),
    },
  }));
}

async function fetchOpenAICompatibleModelInfo(
  baseUrl: string,
  modelName: string,
): Promise<LlmModelInfo> {
  const models = await fetchOpenAICompatibleModels(baseUrl);
  const foundModel = models.find((model) => model.name === modelName);
  return {
    model_info: {
      model: modelName,
    },
    details: {
      ...(foundModel?.details?.parent_model
        ? { parent_model: foundModel.details.parent_model }
        : {}),
    },
  };
}

function getOpenAICompatibleModelContextLimit(_modelInfo: LlmModelInfo): number | null {
  return null;
}

async function sendOpenAICompatibleChat(
  baseUrl: string,
  params: ChatParams,
  onChunk?: (chunk: ChatApiResponse) => void,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ChatApiResponse> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  if (onChunk) {
    // Streaming path with callback — accumulate content/thinking/tool_calls
    // across chunks, call onChunk for each, return the final assembled message.
    const streamParams: StreamChatParams = { ...params, ...(signal ? { signal } : {}) };
    if (timeoutMs !== undefined) streamParams.timeoutMs = timeoutMs;

    const fullMessage: ChatMessage = { role: 'assistant', content: '' };
    let lastChunk: ChatApiResponse | null = null;

    for await (const chunk of sendOpenAICompatibleChatStream(normalizedBaseUrl, streamParams)) {
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

    if (!lastChunk) throw new Error('No response from OpenAI-compatible endpoint');

    return {
      ...lastChunk,
      message: fullMessage,
    };
  }

  // Non-streaming path.
  const config: AxiosRequestConfig = {};
  if (timeoutMs !== undefined) config.timeout = timeoutMs;
  if (signal) config.signal = signal;

  const response = await client.post<OpenAIChatCompletionResponse>(
    `${normalizedBaseUrl}/v1/chat/completions`,
    buildChatPayload(params, false),
    config,
  );

  return toChatApiResponse(response.data);
}

async function* sendOpenAICompatibleChatStream(
  baseUrl: string,
  params: StreamChatParams,
): AsyncGenerator<ChatApiResponse> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  const config: AxiosRequestConfig = {
    responseType: 'stream',
  };
  if (params.signal) config.signal = params.signal;
  if (params.timeoutMs !== undefined) config.timeout = params.timeoutMs;

  const payload = buildChatPayload(params, true);

  let response;
  try {
    response = await client.post<NodeJS.ReadableStream>(
      `${normalizedBaseUrl}/v1/chat/completions`,
      payload,
      config,
    );
  } catch (err) {
  // Debug: log truncated payload on 400 for diagnosis.
  // Keep this safe: err.response.data may be a stream/object with circular
  // references when responseType is 'stream', so never JSON.stringify it raw.
  if (axios.isAxiosError(err) && err.response?.status === 400) {
    console.error('=== OPENAI ADAPTER 400 ERROR ===');
    console.error('URL:', `${normalizedBaseUrl}/v1/chat/completions`);
    // Log just the structure (keys and lengths) to avoid circular refs.
    const summary: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'messages') {
        summary.messages = `[${(v as unknown[]).length} messages]`;
      } else if (k === 'tools') {
        summary.tools = `[${(v as unknown[]).length} tools]`;
      } else {
        summary[k] = v;
      }
    }
    console.error('Payload summary:', JSON.stringify(summary, null, 2));
    // Surface the most common incompatible-field combinations.
    if (payload.reasoning_effort !== undefined && (payload.tools?.length ?? 0) > 0) {
      console.error(
        'PROBABLE CAUSE: reasoning_effort is set while tools are present. ' +
          'Many providers (including Airia) reject this combination.'
      );
    }
    try {
      await writeFile('debug_400_payload.json', JSON.stringify(payload, null, 2));
      console.error('Full payload saved to:', 'debug_400_payload.json');
    } catch {
      // Ignore file write errors in debug logging.
    }
    if (err.response?.data) {
      const data = err.response.data;
      if (typeof data === 'string') {
        console.error('Response:', data.slice(0, 2000));
      } else if (data && typeof data === 'object') {
        // Streams / axios objects can be circular; pull out safe fields only.
        const safeData: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
            safeData[k] = v;
          } else if (Array.isArray(v)) {
            safeData[k] = `[${v.length} items]`;
          } else if (typeof v === 'object') {
            safeData[k] = '[object]';
          }
        }
        console.error('Response:', JSON.stringify(safeData, null, 2).slice(0, 2000));
      }
    }
    console.error('=== END 400 DEBUG ===');
  }
    throw err;
  }

  // Accumulate tool call fragments across chunks by index.
  const toolCallAccumulator = new Map<
    number,
    { id?: string; name?: string; arguments: string }
  >();

  let buffered = '';
  for await (const rawChunk of response.data) {
    buffered += rawChunk.toString('utf8');

    // Split on SSE double-newline (handles both \n\n and \r\n\r\n).
    let splitIndex: number;
    while ((splitIndex = buffered.indexOf('\n\n')) !== -1) {
      const rawEvent = buffered.slice(0, splitIndex).trim();
      buffered = buffered.slice(splitIndex + 2);

      if (!rawEvent) continue;

      // Process each line in the event (some providers send multiple data: lines).
      const lines = rawEvent
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;

        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let parsed: OpenAIChatCompletionChunk;
        try {
          parsed = JSON.parse(data) as OpenAIChatCompletionChunk;
        } catch {
          // Malformed JSON — skip this chunk.
          continue;
        }

        // Handle usage-only chunks (stream_options.include_usage sends
        // a final chunk with empty choices and a usage field).
        if (!parsed.choices || parsed.choices.length === 0) {
          // This is the usage-only chunk; we don't yield it as a separate
          // ChatApiResponse since the final content chunk already carried
          // the done signal. The usage data will be on the last yielded chunk.
          continue;
        }

        const choice = parsed.choices[0];
        const delta = choice?.delta ?? {};

        // Accumulate tool call fragments.
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            let entry = toolCallAccumulator.get(index);
            if (!entry) {
              entry = { arguments: '' };
              toolCallAccumulator.set(index, entry);
            }
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          }
        }

        // Build the message for this chunk.
        const content = delta.content ?? '';
        const isDone = choice?.finish_reason !== null && choice?.finish_reason !== undefined;
        const doneReason = choice?.finish_reason ?? undefined;

        // Only finalize tool calls on the last chunk (when finish_reason is set).
        let toolCalls: ToolCall[] | undefined;
        if (isDone && toolCallAccumulator.size > 0) {
          toolCalls = finalizeToolCalls(toolCallAccumulator);
        }

        const chunk: ChatApiResponse = {
          model: parsed.model,
          created_at: new Date(
            (parsed.created ?? Math.floor(Date.now() / 1000)) * 1000,
          ).toISOString(),
          done: isDone,
          ...(doneReason ? { done_reason: doneReason } : {}),
          message: {
            role: 'assistant',
            content,
            ...(toolCalls && toolCalls.length > 0
              ? { tool_calls: toolCalls as unknown as [ToolCall, ...ToolCall[]] }
              : {}),
          },
          // Attach token counts on the final chunk if available.
          // Only include when usage is non-null and the value is defined.
          ...(isDone && parsed.usage?.prompt_tokens !== undefined
            ? { prompt_eval_count: parsed.usage.prompt_tokens }
            : {}),
          ...(isDone && parsed.usage?.completion_tokens !== undefined
            ? { eval_count: parsed.usage.completion_tokens }
            : {}),
        };

        yield chunk;
      }
    }
  }
}

async function getOpenAICompatibleApiErrorMessage(error: unknown): Promise<string> {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data;

    if (typeof data === 'string' && data.trim()) {
      return status
        ? `OpenAI-compatible API error (${status}): ${data.trim()}`
        : data.trim();
    }

    // Try to parse as the standard OpenAI error response shape.
    if (typeof data === 'object' && data !== null) {
      const errorBody = data as OpenAIErrorResponse;

      // OpenAI format: { error: { message, type, param, code } }
      if (
        typeof errorBody.error === 'object' &&
        errorBody.error !== null &&
        typeof errorBody.error.message === 'string'
      ) {
        return status
          ? `OpenAI-compatible API error (${status}): ${errorBody.error.message}`
          : errorBody.error.message;
      }

      // Some providers return { message: "..." } directly.
      const plainBody = data as Record<string, unknown>;
      if (typeof plainBody.message === 'string') {
        return status
          ? `OpenAI-compatible API error (${status}): ${plainBody.message}`
          : plainBody.message;
      }
    }

    // If data is an HTTP Response object (raw stream), extract the error from it.
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if ('error' in obj) {
        const errMsg = obj.error;
        if (typeof errMsg === 'string') return `OpenAI-compatible API error (${status}): ${errMsg}`;
        if (typeof errMsg === 'object' && errMsg !== null) {
          const inner = (errMsg as Record<string, unknown>).message;
          if (typeof inner === 'string') {
            return `OpenAI-compatible API error (${status}): ${inner}`;
          }
        }
      }
    }

    return status
      ? `OpenAI-compatible API error (${status}): ${error.message}`
      : error.message;
  }

  if (error instanceof Error) return error.message;
  return String(error);
}

// ── Adapter export ───────────────────────────────────────────────────────────

export const openaiCompatibleAdapter: LlmAdapter = {
  id: 'openai-compatible',
  validateConnection: validateOpenAICompatibleConnection,
  fetchModels: fetchOpenAICompatibleModels,
  fetchModelInfo: fetchOpenAICompatibleModelInfo,
  getModelContextLimit: getOpenAICompatibleModelContextLimit,
  sendChat: sendOpenAICompatibleChat,
  sendChatStream: sendOpenAICompatibleChatStream,
  getApiErrorMessage: getOpenAICompatibleApiErrorMessage,
  getTurnStats: (response: ChatApiResponse) => {
    if (
      !Number.isFinite(response.prompt_eval_count) ||
      !Number.isFinite(response.eval_count)
    ) {
      return null;
    }
    return {
      promptEvalCount: response.prompt_eval_count ?? 0,
      evalCount: response.eval_count ?? 0,
    };
  },
};
