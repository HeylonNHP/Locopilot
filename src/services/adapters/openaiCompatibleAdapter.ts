import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { writeFile } from 'node:fs/promises';

import { debugLog } from '@/app/lib/debugLogger';

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

import { getModelContextLimitFromInfo } from '../llmContextLimit';

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

/** Content part types for OpenAI's multi-part user messages (vision). */
type OpenAITextContentPart = { type: 'text'; text: string };
type OpenAIImageContentPart = {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
};
type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

/** A message as sent to the OpenAI Chat Completions API. */
type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | { role: 'assistant'; content: string | null }
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
      reasoning_content?: string | null;
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
      reasoning_content?: string | null;
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
    [key: string]: unknown;
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

/**
 * Detect the MIME type of a base64-encoded image from its magic bytes.
 * Falls back to image/jpeg when the format cannot be determined.
 */
function detectImageMimeTypeFromBase64(base64: string): string {
  try {
    const buf = Buffer.from(base64.slice(0, 8), 'base64');
    if (buf.length < 4) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
      return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46)
      return 'image/webp';
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  } catch {
    return 'image/jpeg';
  }
  return 'image/jpeg';
}

/**
 * Build the OpenAI content payload for a user message. Text stays as a
 * string when there are no images; otherwise it is emitted as a multi-part
 * array containing the text and one `image_url` part per attached image.
 */
function buildOpenAIUserContent(message: ChatMessage): string | OpenAIContentPart[] {
  if (!message.images || message.images.length === 0) {
    return message.content;
  }

  const parts: OpenAIContentPart[] = [{ type: 'text', text: message.content }];

  for (const imageBase64 of message.images) {
    const mimeType = detectImageMimeTypeFromBase64(imageBase64);
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${imageBase64}` },
    });
  }

  return parts;
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  debugLog.messageArraySummary('toOpenAIMessages: input', messages);

  // Walks back over consecutive 'tool' messages to find the assistant that
  // originated the current tool block. Returns the assistant's `tool_calls`
  // array, or `undefined` if no such assistant exists in the run (truly
  // orphaned tool message).
  //
  // OpenAI requires every assistant tool_call to be immediately followed
  // by a tool message responding to it. When the assistant issues multiple
  // parallel tool_calls (e.g. two `web_search` calls in one turn), the
  // resulting tool messages are placed back-to-back. The SECOND tool
  // message in that run has another tool message as its immediate
  // predecessor — not the assistant — so a naive `messages[i-1]` lookup
  // incorrectly flags it as orphan, rewrites it as a user message, and
  // causes OpenAI to reject the request with a 400 ("tool_call_id did
  // not have response messages"). Walking back over the consecutive tool
  // messages finds the originating assistant regardless of where in the
  // run this message sits.
  const findOriginatingAssistantToolCalls = (
    idx: number
  ): ChatMessage['tool_calls'] | undefined => {
    let j = idx - 1;
    while (j >= 0) {
      const candidate = messages[j];
      if (!candidate) return undefined;
      if (candidate.role === 'assistant') {
        return candidate.tool_calls && candidate.tool_calls.length > 0
          ? candidate.tool_calls
          : undefined;
      }
      if (candidate.role !== 'tool') return undefined;
      j -= 1;
    }
    return undefined;
  };

  for (const [i, message_] of messages.entries()) {
    const message = message_!;

    // OpenAI requires that a 'tool' message follows an assistant message
    // that has tool_calls. If no such assistant exists in the contiguous
    // tool run (e.g. the assistant's tool-call message was lost from
    // history), convert the orphaned tool message to a 'user' message so
    // the API doesn't reject the request with a 400.
    if (message.role === 'tool') {
      const originatingToolCalls = findOriginatingAssistantToolCalls(i);
      const hasOriginatingAssistant = !!originatingToolCalls;
      const originatingToolCallCount = originatingToolCalls?.length ?? 0;
      debugLog.toolMessage({
        layer: 'adapter',
        action: 'receive',
        messageIndex: i,
        role: message.role,
        hasToolCallId: !!message.tool_call_id,
        tool_call_id: message.tool_call_id ?? null,
        precedingAssistantToolCalls: originatingToolCallCount,
        contentPreview: message.content || '',
      });
      if (!hasOriginatingAssistant) {
        // Orphaned tool message — convert to user so it's still sent as context.
        debugLog.toolMessage({
          layer: 'adapter',
          action: 'convert',
          messageIndex: i,
          role: 'tool',
          hasToolCallId: !!message.tool_call_id,
          tool_call_id: message.tool_call_id ?? null,
          precedingAssistantToolCalls: 0,
          contentPreview: message.content || '',
          reason: 'orphan',
        });
        result.push({
          role: 'user',
          content: message.content || '',
        });
        continue;
      }
      // When the originating assistant issued multiple tool_calls and this
      // tool message is missing tool_call_id, we cannot safely guess which
      // tool_call it responds to. Falling back to the first id would assign
      // every orphaned response to that id, leaving the other tool_calls
      // without responses and causing OpenAI 400 errors. Treat it as an orphan.
      if (!message.tool_call_id && originatingToolCalls!.length > 1) {
        debugLog.toolMessage({
          layer: 'adapter',
          action: 'convert',
          messageIndex: i,
          role: 'tool',
          hasToolCallId: false,
          tool_call_id: null,
          precedingAssistantToolCalls: originatingToolCallCount,
          contentPreview: message.content || '',
          reason: 'multi-tool-missing-id',
        });
        result.push({
          role: 'user',
          content: message.content || '',
        });
        continue;
      }
    }

    // OpenAI requires content: null for assistant messages that only have tool_calls.
    const hasToolCalls = !!message.tool_calls && message.tool_calls.length > 0;
    const content: string | null | OpenAIContentPart[] =
      hasToolCalls && !message.content?.trim()
        ? null
        : message.role === 'user' && message.images && message.images.length > 0
          ? buildOpenAIUserContent(message)
          : message.content;

    const base: OpenAIMessage = {
      role: message.role,
      content,
    } as OpenAIMessage;

    if (message.tool_call_id) {
      (base as { tool_call_id: string }).tool_call_id = message.tool_call_id;
    } else if (message.role === 'tool') {
      // tool_call_id is not persisted in the session database, so it may
      // be missing when loading history. Use the id from the originating
      // assistant message's tool_calls as a fallback.
      // Multi-tool assistant turns are handled above: when there is more
      // than one tool_call, guessing the first id is unsafe, so the message
      // is converted to a user message instead of reaching this branch.
      const originatingToolCalls = findOriginatingAssistantToolCalls(i);
      const fallbackId = originatingToolCalls?.[0]?.id || 'call_fallback_0';
      (base as { tool_call_id: string }).tool_call_id = fallbackId;
      debugLog.toolMessage({
        layer: 'adapter',
        action: 'convert',
        messageIndex: i,
        role: 'tool',
        hasToolCallId: false,
        tool_call_id: null,
        precedingAssistantToolCalls: originatingToolCalls?.length ?? 0,
        contentPreview: message.content || '',
        reason: 'fallback-tool-call-id',
        fallbackId,
      });
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
        })
      );
    }

    result.push(base);
  }

  debugLog.messageArraySummary('toOpenAIMessages: output', result);
  return result;
}

/**
 * Recursively strip `description` fieldss from a tool parameter schema object.
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

  // Canonical output-token limit. This maps to max_completion_tokens so it
  // works for both reasoning and non-reasoning OpenAI-compatible models.
  // The canonical field takes precedence; legacy options are fallbacks.
  if (params.maxOutputTokens !== undefined) {
    payload.max_completion_tokens = params.maxOutputTokens;
  } else if (params.options?.max_completion_tokens !== undefined) {
    payload.max_completion_tokens = params.options.max_completion_tokens as number;
  } else if (params.options?.max_tokens !== undefined) {
    payload.max_tokens = params.options.max_tokens as number;
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
  const reasoningContent = choice?.message.reasoning_content ?? '';
  const toolCalls: ToolCall[] | undefined = choice?.message.tool_calls?.map((toolCall) => ({
    id: toolCall.id,
    function: {
      name: toolCall.function.name,
      arguments: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
    },
  }));

  return {
    model: response.model,
    created_at: new Date((response.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    done: true,
    ...(choice?.finish_reason ? { done_reason: choice.finish_reason } : {}),
    message: {
      role: 'assistant',
      content,
      ...(reasoningContent ? { thinking: reasoningContent } : {}),
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
}

// ── API methods ──────────────────────────────────────────────────────────────

async function fetchOpenAICompatibleModels(baseUrl: string): Promise<LlmModel[]> {
  const response = await client.get<OpenAIListModelsResponse>(
    `${baseUrl.replace(/\/+$/, '')}/v1/models`
  );
  return (response.data.data ?? []).map((model) => {
    const { id, object: _object, created: _created, owned_by, ...extra } = model;
    return {
      name: id,
      model: id,
      details: {
        ...(owned_by ? { parent_model: owned_by } : {}),
      },
      ...extra, // pass through non-standard fields (e.g. max_context_length)
    };
  });
}

async function fetchOpenAICompatibleModelInfo(
  baseUrl: string,
  modelName: string
): Promise<LlmModelInfo> {
  const models = await fetchOpenAICompatibleModels(baseUrl);
  const foundModel = models.find((model) => model.name === modelName);
  return {
    model_info: {
      model: modelName,
      ...(foundModel
        ? Object.fromEntries(
            Object.entries(foundModel).filter(([k]) => k !== 'name' && k !== 'model')
          )
        : {}),
    },
    details: {
      ...(foundModel?.details?.parent_model
        ? { parent_model: foundModel.details.parent_model }
        : {}),
    },
  };
}

// ── Context limit discovery ───────────────────────────────────────────────────
// OpenAI's /v1/models endpoint does not return context window size, but some
// OpenAI-compatible providers (LM Studio, vLLM, etc.) include non-standard
// fields like max_context_length, context_length, context_window, etc. The
// shared llmContextLimit util recursively walks the model-info payload for
// these keys and falls back to scanning free-form `parameters` / `modelfile`
// text for `num_ctx N` declarations.

async function sendOpenAICompatibleChat(
  baseUrl: string,
  params: ChatParams,
  onChunk?: (chunk: ChatApiResponse) => void,
  timeoutMs?: number,
  signal?: AbortSignal
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
    config
  );

  return toChatApiResponse(response.data);
}

async function* sendOpenAICompatibleChatStream(
  baseUrl: string,
  params: StreamChatParams
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
      config
    );
  } catch (err) {
    // On 400, try to read the error stream to surface the real API message
    // to the UI and to disk.  With responseType: 'stream', err.response.data
    // is a ReadableStream — the standard OpenAI error body is in there.
    if (axios.isAxiosError(err) && err.response?.status === 400) {
      let apiMessage = '';
      try {
        const stream = err.response.data as NodeJS.ReadableStream;
        // Read the first chunk (the error body is typically small).
        const chunk = await new Promise<Buffer>((resolve, reject) => {
          const onData = (data: Buffer) => {
            cleanup();
            resolve(data);
          };
          const onEnd = () => {
            cleanup();
            resolve(Buffer.from(''));
          };
          const onError = (e: Error) => {
            cleanup();
            reject(e);
          };
          const cleanup = () => {
            stream.off('data', onData);
            stream.off('end', onEnd);
            stream.off('error', onError);
          };
          stream.once('data', onData);
          stream.once('end', onEnd);
          stream.once('error', onError);
        });
        if (chunk.length > 0) {
          const text = chunk.toString('utf8');
          // Try standard OpenAI error shape: { error: { message } }
          try {
            const parsed = JSON.parse(text);
            if (parsed?.error?.message) {
              apiMessage = parsed.error.message;
            } else if (parsed?.message) {
              apiMessage = parsed.message;
            }
          } catch {
            // Not JSON — use the raw text (truncated).
            apiMessage = text.slice(0, 500);
          }
        }
      } catch {
        // Best-effort: if reading the stream fails, fall through.
      }

      // Attach the real message to the error so getLlmApiErrorMessage
      // and disk logging both see it.
      if (apiMessage) {
        err.message = `OpenAI-compatible API error (400): ${apiMessage}`;
      }

      // Debug logging (kept simple — no circular-ref risk since we
      // already consumed the stream above).
      console.error('=== OPENAI ADAPTER 400 ERROR ===');
      console.error('URL:', `${normalizedBaseUrl}/v1/chat/completions`);
      console.error('API message:', apiMessage || '(none)');
      try {
        await writeFile(
          'debug_400_payload.json',
          JSON.stringify(
            {
              request: payload,
              response: { message: apiMessage || null },
            },
            null,
            2
          )
        );
        console.error('Debug data saved to:', 'debug_400_payload.json');
      } catch {
        // Ignore file write errors in debug logging.
      }
      console.error('=== END 400 DEBUG ===');
    }
    throw err;
  }

  // Accumulate tool call fragments across chunks by index.
  const toolCallAccumulator = new Map<number, { id?: string; name?: string; arguments: string }>();

  // OpenAI sends usage data on a trailing chunk with empty choices.
  // We skip yielding that chunk, but we stash its usage so the final
  // content chunk can carry the real token counts.
  let pendingUsage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined;

  // The done chunk is yielded only after we have processed any trailing
  // usage-only chunk, so the consumer sees authoritative token counts on
  // the same chunk that signals completion.
  let bufferedDoneChunk: ChatApiResponse | undefined;

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
          // Apply the usage to the buffered done chunk if we are holding one.
          if (parsed.usage && bufferedDoneChunk) {
            if (parsed.usage.prompt_tokens !== undefined) {
              bufferedDoneChunk.prompt_eval_count = parsed.usage.prompt_tokens;
            }
            if (parsed.usage.completion_tokens !== undefined) {
              bufferedDoneChunk.eval_count = parsed.usage.completion_tokens;
            }
          } else if (parsed.usage) {
            pendingUsage = parsed.usage;
          }
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
        const reasoningContent = delta.reasoning_content ?? '';
        const isDone = choice?.finish_reason !== null && choice?.finish_reason !== undefined;
        const doneReason = choice?.finish_reason ?? undefined;

        // Only finalize tool calls on the last chunk (when finish_reason is set).
        let toolCalls: ToolCall[] | undefined;
        if (isDone && toolCallAccumulator.size > 0) {
          toolCalls = finalizeToolCalls(toolCallAccumulator);
        }

        // OpenAI sends usage data on a trailing empty-choices chunk. We
        // stashed it in `pendingUsage`; now prefer it, then fall back to
        // usage directly present on this chunk.
        const usage = pendingUsage ?? parsed.usage;
        if (isDone) {
          pendingUsage = undefined;
        }

        const chunk: ChatApiResponse = {
          model: parsed.model,
          created_at: new Date(
            (parsed.created ?? Math.floor(Date.now() / 1000)) * 1000
          ).toISOString(),
          done: isDone,
          ...(doneReason ? { done_reason: doneReason } : {}),
          message: {
            role: 'assistant',
            content,
            ...(reasoningContent ? { thinking: reasoningContent } : {}),
            ...(toolCalls && toolCalls.length > 0
              ? { tool_calls: toolCalls as unknown as [ToolCall, ...ToolCall[]] }
              : {}),
          },
          // Attach token counts on the final chunk if available.
          ...(isDone && usage?.prompt_tokens !== undefined
            ? { prompt_eval_count: usage.prompt_tokens }
            : {}),
          ...(isDone && usage?.completion_tokens !== undefined
            ? { eval_count: usage.completion_tokens }
            : {}),
        };

        // Defer yielding the done chunk until the trailing usage-only chunk
        // has been processed (or the stream ends). This ensures the chunk
        // the consumer receives as "done" carries authoritative token counts.
        if (isDone) {
          bufferedDoneChunk = chunk;
          continue;
        }

        if (bufferedDoneChunk) {
          yield bufferedDoneChunk;
          bufferedDoneChunk = undefined;
        }
        yield chunk;
      }
    }
  }

  // Flush any deferred done chunk when the stream ends. This handles
  // providers that do not send a trailing usage-only chunk.
  if (bufferedDoneChunk) {
    yield bufferedDoneChunk;
  }
}

async function getOpenAICompatibleApiErrorMessage(error: unknown): Promise<string> {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data;

    if (typeof data === 'string' && data.trim()) {
      return status ? `OpenAI-compatible API error (${status}): ${data.trim()}` : data.trim();
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

    return status ? `OpenAI-compatible API error (${status}): ${error.message}` : error.message;
  }

  if (error instanceof Error) return error.message;
  return String(error);
}

// ── Adapter export ───────────────────────────────────────────────────────────

export const openaiCompatibleAdapter: LlmAdapter = {
  id: 'openai-compatible',
  fetchModels: fetchOpenAICompatibleModels,
  fetchModelInfo: fetchOpenAICompatibleModelInfo,
  getModelContextLimit: getModelContextLimitFromInfo,
  sendChat: sendOpenAICompatibleChat,
  sendChatStream: sendOpenAICompatibleChatStream,
  getApiErrorMessage: getOpenAICompatibleApiErrorMessage,
  getTurnStats: (response: ChatApiResponse) => {
    if (!Number.isFinite(response.prompt_eval_count) || !Number.isFinite(response.eval_count)) {
      return null;
    }
    return {
      promptEvalCount: response.prompt_eval_count ?? 0,
      evalCount: response.eval_count ?? 0,
    };
  },
};
