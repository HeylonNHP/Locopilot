import axios, { type AxiosInstance } from 'axios';
import { writeFile } from 'node:fs/promises';
import OpenAI from 'openai';
import type {
  EasyInputMessage,
  FunctionTool,
  Response,
  ResponseCreateParamsBase,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStreamEvent,
  ResponseTextConfig,
} from 'openai/resources/responses/responses';
import type { Stream } from 'openai/streaming';

import { debugLog } from '@/app/lib/debugLogger';
import { getModelContextLimitFromInfo } from '@/services/llmContextLimit';

import type {
  ChatApiResponse,
  ChatMessage,
  ChatParams,
  LlmAdapter,
  LlmModel,
  LlmModelInfo,
  LlmRequestContext,
  StreamChatParams,
  ToolCall,
} from './llmAdapter';

// ── Per-request OpenAI client ──────────────────────────────────────────────
// We must NOT keep a single module-level client configured for one
// provider/apiKey — two concurrent requests with different credentials would
// race on the singleton. Instead, `buildClient(ctx)` returns a fresh OpenAI
// instance per call.

let legacyClientWarningShown = false;

function legacyClientWarning(): void {
  if (legacyClientWarningShown) return;
  legacyClientWarningShown = true;
  console.warn(
    '[openaiCompatibleAdapter] setApiKey/clearApiKey are deprecated no-ops; ' +
      'pass apiKey via the per-request LlmRequestContext instead.'
  );
}

/**
 * Build a per-request OpenAI client for the OpenAI-compatible provider.
 * The `baseURL` and `apiKey` come from the request context so concurrent
 * requests with different credentials never leak state.
 */
function buildClient(ctx: LlmRequestContext): OpenAI {
  const baseURL = `${ctx.baseUrl.replace(/\/+$/, '')}/v1`;
  return new OpenAI({
    baseURL,
    apiKey: ctx.apiKey || 'sk-placeholder',
    // Some OpenAI-compatible providers (e.g. Ollama, LM Studio) don't
    // require an API key. The SDK requires a non-empty string, so we
    // provide a placeholder when none is configured.
    dangerouslyAllowBrowser: true,
  });
}

/**
 * Build a per-request axios client for the OpenAI-compatible provider.
 * Used only for model listing (/v1/models) which the SDK doesn't expose
 * for custom endpoints.
 */
function buildAxiosClient(ctx: LlmRequestContext): AxiosInstance {
  if (ctx.apiKey && ctx.apiKey.length > 0) {
    return axios.create({
      headers: { Authorization: `Bearer ${ctx.apiKey}` },
    });
  }
  return axios;
}

/**
 * @deprecated Configure the apiKey via the per-request LlmRequestContext
 * passed to `sendChat`/`sendChatStream`. This no-op is kept so legacy
 * callers do not crash.
 */
export function setApiKey(_apiKey: string): void {
  legacyClientWarning();
}

/**
 * @deprecated Configure the apiKey via the per-request LlmRequestContext
 * passed to `sendChat`/`sendChatStream`. This no-op is kept so legacy
 * callers do not crash.
 */
export function clearApiKey(): void {
  legacyClientWarning();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

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
      if (key === 'description') continue;
      result[key] = stripDescriptions(value);
    }
    return result;
  }
  return obj;
}

// ── Message / input mapping ────────────────────────────────────────────────

/**
 * Build the Responses API input content array for a user message.
 * Text stays as a simple string when there are no images; otherwise it is
 * emitted as a multi-part array containing text and one `input_image` per
 * attached image.
 */
function buildUserContent(
  message: ChatMessage
): string | Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }> {
  if (!message.images || message.images.length === 0) {
    return message.content;
  }

  const parts: Array<
    { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }
  > = [{ type: 'input_text', text: message.content }];

  for (const imageBase64 of message.images) {
    const mimeType = detectImageMimeTypeFromBase64(imageBase64);
    parts.push({
      type: 'input_image',
      image_url: `data:${mimeType};base64,${imageBase64}`,
      detail: 'auto',
    });
  }

  return parts;
}

/**
 * Convert the app's internal ChatMessage array into the Responses API
 * input items format.
 *
 * System messages are collected into the `instructions` string (returned
 * separately). User/assistant messages become EasyInputMessage items.
 * Tool calls from the assistant become ResponseFunctionToolCall items.
 * Tool results become FunctionCallOutput items.
 */
function toResponseInputItems(
  messages: ChatMessage[]
): { instructions: string | null; input: ResponseInputItem[] } {
  const instructions: string[] = [];
  const input: ResponseInputItem[] = [];

  debugLog.messageArraySummary('toResponseInputItems: input', messages);

  // Walk backward to find the originating assistant for tool messages.
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

  for (const [i, msg] of messages.entries()) {
    if (!msg) continue;

    if (msg.role === 'system') {
      instructions.push(msg.content);
      continue;
    }

    if (msg.role === 'user') {
      const content = buildUserContent(msg);
      const item: EasyInputMessage = {
        role: 'user',
        content,
        type: 'message',
      };
      input.push(item as ResponseInputItem);
      continue;
    }

    if (msg.role === 'assistant') {
      // Assistant message text content.
      const hasToolCalls = !!msg.tool_calls && msg.tool_calls.length > 0;
      const content = hasToolCalls && !msg.content?.trim() ? '' : msg.content || '';

      const assistantItem: EasyInputMessage = {
        role: 'assistant',
        content,
        type: 'message',
      };
      input.push(assistantItem as ResponseInputItem);

      // Tool calls from this assistant.
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const toolCallItem: ResponseFunctionToolCall = {
            call_id: tc.id || `call_fallback_${i}`,
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments),
            type: 'function_call',
            status: 'completed',
          };
          input.push(toolCallItem);
        }
      }
      continue;
    }

    if (msg.role === 'tool') {
      // Find the originating assistant to get the tool_call_id.
      const originatingToolCalls = findOriginatingAssistantToolCalls(i);
      const hasOriginatingAssistant = !!originatingToolCalls;

      if (!hasOriginatingAssistant) {
        // Orphaned tool message — convert to user message.
        debugLog.toolMessage({
          layer: 'adapter',
          action: 'convert',
          messageIndex: i,
          role: 'tool',
          hasToolCallId: !!msg.tool_call_id,
          tool_call_id: msg.tool_call_id ?? null,
          precedingAssistantToolCalls: 0,
          contentPreview: msg.content || '',
          reason: 'orphan',
        });
        const item: EasyInputMessage = {
          role: 'user',
          content: msg.content || '',
          type: 'message',
        };
        input.push(item as ResponseInputItem);
        continue;
      }

      // When the originating assistant issued multiple tool_calls and this
      // tool message is missing tool_call_id, we cannot safely guess which
      // tool_call it responds to. Treat it as an orphan.
      if (!msg.tool_call_id && originatingToolCalls!.length > 1) {
        debugLog.toolMessage({
          layer: 'adapter',
          action: 'convert',
          messageIndex: i,
          role: 'tool',
          hasToolCallId: false,
          tool_call_id: null,
          precedingAssistantToolCalls: originatingToolCalls!.length,
          contentPreview: msg.content || '',
          reason: 'multi-tool-missing-id',
        });
        const item: EasyInputMessage = {
          role: 'user',
          content: msg.content || '',
          type: 'message',
        };
        input.push(item as ResponseInputItem);
        continue;
      }

      const callId = msg.tool_call_id || originatingToolCalls![0]?.id || `call_fallback_${i}`;
      const toolOutput: ResponseInputItem.FunctionCallOutput = {
        call_id: callId,
        output: msg.content || '',
        type: 'function_call_output',
      };
      input.push(toolOutput);
    }
  }

  const result = {
    instructions: instructions.length > 0 ? instructions.join('\n\n') : null,
    input,
  };

  debugLog.messageArraySummary('toResponseInputItems: output items', input as unknown as ChatMessage[]);
  return result;
}

// ── Tool mapping ───────────────────────────────────────────────────────────

function toResponseTools(tools: ChatParams['tools']): FunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((tool) => {
    const strippedParams = stripDescriptions(tool.function.parameters) as Record<string, unknown>;
    return {
      type: 'function' as const,
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: strippedParams,
      strict: false,
    };
  });
}

// ── Response mapping ───────────────────────────────────────────────────────

/**
 * Extract the text content from a ResponseOutputMessage.
 */
function extractMessageText(outputMessage: ResponseOutputMessage): string {
  if (!outputMessage.content || outputMessage.content.length === 0) return '';
  // Concatenate all text parts (skip refusals).
  return outputMessage.content
    .filter((part) => part.type === 'output_text')
    .map((part) => (part as { text: string }).text)
    .join('');
}

/**
 * Extract reasoning text from a ResponseReasoningItem.
 */
function extractReasoningText(reasoningItem: ResponseReasoningItem): string {
  if (!reasoningItem.summary || reasoningItem.summary.length === 0) return '';
  return reasoningItem.summary.map((s) => s.text).join('');
}

/**
 * Map a non-streaming Response to the app's ChatApiResponse format.
 */
function toChatApiResponse(response: Response): ChatApiResponse {
  let content = '';
  let thinking = '';
  const toolCalls: ToolCall[] = [];

  for (const item of response.output) {
    switch (item.type) {
      case 'message': {
        content = extractMessageText(item as ResponseOutputMessage);
        break;
      }
      case 'reasoning': {
        thinking = extractReasoningText(item as ResponseReasoningItem);
        break;
      }
      case 'function_call': {
        const fc = item as ResponseFunctionToolCall;
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(fc.arguments) as Record<string, unknown>;
        } catch {
          parsedArgs = {};
        }
        toolCalls.push({
          id: fc.call_id,
          function: {
            name: fc.name,
            arguments: parsedArgs,
          },
        });
        break;
      }
    }
  }

  // Determine done_reason from response status / incomplete_details.
  let doneReason: string | undefined;
  switch (response.status) {
    case 'failed': {
      doneReason = 'error';
      break;
    }
    case 'incomplete': {
      doneReason = response.incomplete_details?.reason || 'length';
      break;
    }
    case 'completed': {
      doneReason = 'stop';
      break;
    }
  }

  return {
    model: response.model,
    created_at: new Date((response.created_at ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    done: true,
    ...(doneReason ? { done_reason: doneReason } : {}),
    message: {
      role: 'assistant',
      content,
      ...(thinking ? { thinking } : {}),
      ...(toolCalls.length > 0
        ? { tool_calls: toolCalls as unknown as [ToolCall, ...ToolCall[]] }
        : {}),
    },
    ...(response.usage
      ? {
          prompt_eval_count: response.usage.input_tokens,
          eval_count: response.usage.output_tokens,
        }
      : {}),
  };
}

// ── Streaming ──────────────────────────────────────────────────────────────

/**
 * Accumulator for streaming tool call fragments.
 */
interface PartialToolCall {
  call_id?: string;
  name?: string;
  arguments: string;
}

/**
 * Finalize accumulated tool call fragments into ToolCall[].
 */
function finalizeToolCalls(accumulator: Map<number, PartialToolCall>): ToolCall[] | undefined {
  if (accumulator.size === 0) return undefined;

  const calls: ToolCall[] = [];
  const sortedIndices = [...accumulator.keys()].sort((a, b) => a - b);

  for (const index of sortedIndices) {
    const partial = accumulator.get(index)!;
    if (!partial.call_id || !partial.name) continue;

    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(partial.arguments) as Record<string, unknown>;
    } catch {
      parsedArgs = {};
    }

    calls.push({
      id: partial.call_id,
      function: {
        name: partial.name,
        arguments: parsedArgs,
      },
    });
  }

  return calls.length > 0 ? (calls as unknown as [ToolCall, ...ToolCall[]]) : undefined;
}

/**
 * Iterate over a stream of ResponseStreamEvent and yield ChatApiResponse chunks.
 */
async function* streamResponseEvents(
  stream: Stream<ResponseStreamEvent>
): AsyncGenerator<ChatApiResponse> {
  const toolCallAccumulator = new Map<number, PartialToolCall>();
  let accumulatedContent = '';
  let accumulatedReasoning = '';
  let finalResponse: Response | null = null;
  let yieldedAnyChunk = false;
  let hasReasoningDeltas = false;

  for await (const event of stream) {
    switch (event.type) {
      case 'response.output_text.delta': {
        const delta = (event as { delta: string }).delta;
        accumulatedContent += delta;
        yieldedAnyChunk = true;
        yield {
          model: '',
          created_at: new Date().toISOString(),
          done: false,
          message: {
            role: 'assistant',
            content: delta,
          },
        };
        break;
      }

      // The API emits either raw reasoning deltas or visible summary deltas
      // depending on the provider. Accumulate both as thinking text.
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const delta = (event as { delta: string }).delta;
        accumulatedReasoning += delta;
        hasReasoningDeltas = true;
        yieldedAnyChunk = true;
        yield {
          model: '',
          created_at: new Date().toISOString(),
          done: false,
          message: {
            role: 'assistant',
            content: '',
            thinking: delta,
          },
        };
        break;
      }

      // Some providers emit completed summary parts instead of (or in addition
      // to) deltas. Treat them the same as thinking text.
      // When deltas have already been received, skip the summary part to avoid
      // double-accumulating the same reasoning text.
      case 'response.reasoning_summary_part.added': {
        if (hasReasoningDeltas) break;
        const part = (event as { part?: { type: string; text?: string } }).part;
        if (part?.type === 'summary_text' && part.text) {
          accumulatedReasoning += part.text;
          yieldedAnyChunk = true;
          yield {
            model: '',
            created_at: new Date().toISOString(),
            done: false,
            message: {
              role: 'assistant',
              content: '',
              thinking: part.text,
            },
          };
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const fcEvent = event as {
          delta: string;
          output_index: number;
          call_id?: string;
          name?: string;
        };
        const index = fcEvent.output_index;
        let entry = toolCallAccumulator.get(index);
        if (!entry) {
          entry = { arguments: '' };
          toolCallAccumulator.set(index, entry);
        }
        if (fcEvent.call_id) entry.call_id = fcEvent.call_id;
        if (fcEvent.name) entry.name = fcEvent.name;
        entry.arguments += fcEvent.delta;
        break;
      }

      case 'response.output_item.done': {
        // When a function_call item is done, we may have the full arguments.
        const itemDone = event as { item: ResponseOutputItem; output_index: number };
        if (itemDone.item.type === 'function_call') {
          const fc = itemDone.item as ResponseFunctionToolCall;
          const index = itemDone.output_index;
          let entry = toolCallAccumulator.get(index);
          if (!entry) {
            entry = { arguments: '' };
            toolCallAccumulator.set(index, entry);
          }
          if (fc.call_id) entry.call_id = fc.call_id;
          if (fc.name) entry.name = fc.name;
          if (fc.arguments) entry.arguments = fc.arguments;
        }
        break;
      }

      case 'response.completed': {
        const completedEvent = event as { response: Response };
        finalResponse = completedEvent.response;
        break;
      }

      // Reasoning part completed — no delta to process, just a signal that
      // the reasoning text block has finished.
      case 'response.reasoning_text.done':
      case 'response.reasoning_summary_text.done': {
        break;
      }

      default: {
        if (
          typeof (event as { type?: string }).type === 'string' &&
          (event as { type?: string }).type!.includes('reasoning')
        ) {
          console.warn(
            '[openaiCompatibleAdapter] unhandled reasoning event:',
            (event as { type?: string }).type,
            JSON.stringify(event).slice(0, 200)
          );
        }
        break;
      }
    }
  }

  // If we never yielded any content chunks but have a final response, yield it now.
  if (!yieldedAnyChunk && finalResponse) {
    const mapped = toChatApiResponse(finalResponse);
    yield mapped;
    return;
  }

  // Yield the final done chunk with usage and metadata only.
  // Content and thinking are NOT included — they were already streamed
  // piece-by-piece via delta events, and the consumer appends every chunk's
  // content/thinking to its own accumulators. Re-sending the full text here
  // would double everything in the final output.
  if (finalResponse) {
    const toolCalls = finalizeToolCalls(toolCallAccumulator);
    const doneReason = finalResponse.status === 'completed'
      ? 'stop'
      : finalResponse.status === 'incomplete'
        ? finalResponse.incomplete_details?.reason || 'length'
        : finalResponse.status === 'failed'
          ? 'error'
          : undefined;

    yield {
      model: finalResponse.model,
      created_at: new Date(
        (finalResponse.created_at ?? Math.floor(Date.now() / 1000)) * 1000
      ).toISOString(),
      done: true,
      ...(doneReason ? { done_reason: doneReason } : {}),
      message: {
        role: 'assistant',
        content: '',
        ...(toolCalls && toolCalls.length > 0
          ? { tool_calls: toolCalls as unknown as [ToolCall, ...ToolCall[]] }
          : {}),
      },
      ...(finalResponse.usage
        ? {
            prompt_eval_count: finalResponse.usage.input_tokens,
            eval_count: finalResponse.usage.output_tokens,
          }
        : {}),
    };
  }
}

// ── API methods ────────────────────────────────────────────────────────────

async function fetchOpenAICompatibleModels(ctx: LlmRequestContext): Promise<LlmModel[]> {
  const client = buildAxiosClient(ctx);
  const response = await client.get<{
    object: string;
    data: Array<{
      id: string;
      object: string;
      created: number;
      owned_by: string;
      [key: string]: unknown;
    }>;
  }>(`${ctx.baseUrl.replace(/\/+$/, '')}/v1/models`);
  return (response.data.data ?? []).map((model) => {
    const { id, object: _object, created: _created, owned_by, ...extra } = model;
    return {
      name: id,
      model: id,
      details: {
        ...(owned_by ? { parent_model: owned_by } : {}),
      },
      ...extra,
    };
  });
}

async function fetchOpenAICompatibleModelInfo(
  ctx: LlmRequestContext,
  modelName: string
): Promise<LlmModelInfo> {
  const models = await fetchOpenAICompatibleModels(ctx);
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

// ── Chat ───────────────────────────────────────────────────────────────────

function buildResponseParams(
  params: ChatParams,
  stream: boolean
): ResponseCreateParamsBase {
  const effectiveMessages =
    params.visionSupported === false ? stripImagesFromMessages(params.messages) : params.messages;

  const { instructions, input } = toResponseInputItems(effectiveMessages);

  const payload: ResponseCreateParamsBase = {
    model: params.model,
    input,
    stream,
  };

  if (instructions) {
    payload.instructions = instructions;
  }

  // Tools.
  const tools = toResponseTools(params.tools);
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  // Standard generation parameters.
  if (params.options) {
    if (params.options.temperature !== undefined) {
      payload.temperature = params.options.temperature as number;
    }
    if (params.options.top_p !== undefined) {
      payload.top_p = params.options.top_p as number;
    }
  }

  // Canonical output-token limit.
  if (params.maxOutputTokens !== undefined) {
    payload.max_output_tokens = params.maxOutputTokens;
  }

  // Reasoning effort — maps to the `reasoning.effort` field.
  // `summary: 'auto'` asks the Responses API to return visible reasoning text
  // instead of encrypted reasoning tokens.
  if (params.reasoningEffort !== undefined) {
    const effort = params.reasoningEffort === 'off' ? 'none' : params.reasoningEffort;
    payload.reasoning = {
      effort,
      ...(effort === 'none' ? {} : { summary: 'auto' as const }),
    };
  } else if (params.think !== undefined) {
    // Fallback for the boolean Ollama-style Thinking toggle.
    // Unlike the previous Chat Completions path, the Responses API supports
    // reasoning alongside function tools, so we do not suppress it when tools
    // are present. `false` explicitly disables reasoning with `effort: 'none'`.
    payload.reasoning = {
      effort: params.think ? 'medium' : 'none',
      ...(params.think ? { summary: 'auto' as const } : {}),
    };
  }

  if (payload.reasoning) {
    console.warn('[openaiCompatibleAdapter] reasoning payload:', JSON.stringify(payload.reasoning));
  }

  // Response format (JSON mode, structured output).
  if (params.format !== undefined) {
    if (typeof params.format === 'string') {
      // Map legacy string values to the proper object format.
      payload.text = params.format === 'json' ? { format: { type: 'json_object' } } : { format: { type: 'text' } };
    } else {
      // Record<string, unknown> — assume it's a JSON schema config.
      // Cast through unknown first to satisfy TypeScript's structural typing.
      payload.text = {
        format: params.format as unknown as NonNullable<ResponseTextConfig['format']>,
      };
    }
  }

  return payload;
}

async function sendOpenAICompatibleChat(
  ctx: LlmRequestContext,
  params: ChatParams,
  onChunk?: (chunk: ChatApiResponse) => void,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<ChatApiResponse> {
  const client = buildClient(ctx);

  if (onChunk) {
    // Streaming path with callback.
    const streamParams: StreamChatParams = { ...params, ...(signal ? { signal } : {}) };
    if (timeoutMs !== undefined) streamParams.timeoutMs = timeoutMs;

    const fullMessage: ChatMessage = { role: 'assistant', content: '' };
    let lastChunk: ChatApiResponse | null = null;

    for await (const chunk of sendOpenAICompatibleChatStream(ctx, streamParams)) {
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
  const payload = buildResponseParams(params, false);
  const requestOptions: Record<string, unknown> = {};
  if (timeoutMs !== undefined) requestOptions.timeout = timeoutMs;
  if (signal) requestOptions.signal = signal;

  try {
    const response = await client.responses.create(
      payload as Parameters<typeof client.responses.create>[0],
      requestOptions as Parameters<typeof client.responses.create>[1]
    );
    return toChatApiResponse(response as Response);
  } catch (err) {
    // Enrich error with debug dump on failure.
    await writeDebugDump('400', ctx.baseUrl, params.model, payload, err);
    throw err;
  }
}

async function* sendOpenAICompatibleChatStream(
  ctx: LlmRequestContext,
  params: StreamChatParams
): AsyncGenerator<ChatApiResponse> {
  const client = buildClient(ctx);
  const payload = buildResponseParams(params, true);

  let stream: Stream<ResponseStreamEvent>;
  try {
    const requestOptions: Record<string, unknown> = {};
    if (params.signal) requestOptions.signal = params.signal;
    if (params.timeoutMs !== undefined) requestOptions.timeout = params.timeoutMs;

    stream = (await client.responses.create(
      { ...payload, stream: true } as Parameters<typeof client.responses.create>[0],
      requestOptions as Parameters<typeof client.responses.create>[1]
    )) as unknown as Stream<ResponseStreamEvent>;
  } catch (err) {
    await writeDebugDump('400', ctx.baseUrl, params.model, payload, err);
    throw err;
  }

  yield* streamResponseEvents(stream);
}

// ── Error handling ─────────────────────────────────────────────────────────

async function getOpenAICompatibleApiErrorMessage(error: unknown): Promise<string> {
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const message = error.message || '';
    return status ? `OpenAI-compatible API error (${status}): ${message}` : message;
  }

  if (error instanceof Error) return error.message;
  return String(error);
}

// ── Debug dump ────────────────────────────────────────────────────────────

async function writeDebugDump(
  tag: string,
  baseUrl: string,
  model: string | undefined,
  request: unknown,
  error: unknown
): Promise<void> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const stamp = new Date().toISOString().replaceAll(/[.:]/g, '-');
  const dumpPath = `debug_${tag}_${stamp}.json`;

  let apiMessage = '';
  let statusCode: number | undefined;
  const rawBody: string | null = null;

  if (error instanceof OpenAI.APIError) {
    statusCode = error.status;
    apiMessage = error.message || '';
  } else if (error instanceof Error) {
    apiMessage = error.message;
  }

  console.error(`=== OPENAI ADAPTER ${tag} ERROR ===`);
  console.error('URL:', `${normalizedBaseUrl}/responses`);
  console.error('API message:', apiMessage || '(none)');
  try {
    await writeFile(
      dumpPath,
      JSON.stringify(
        {
          url: `${normalizedBaseUrl}/responses`,
          model,
          request,
          response: {
            status: statusCode,
            message: apiMessage || null,
            rawBody,
          },
        },
        null,
        2
      )
    );
    console.error('Debug data saved to:', dumpPath);
  } catch {
    // Ignore file write errors in debug logging.
  }
  console.error(`=== END ${tag} DEBUG ===`);
}

// ── Adapter export ──────────────────────────────────────────────────────────

export const openaiCompatibleAdapter: LlmAdapter = {
  id: 'openai-compatible',
  buildRequestClient: buildAxiosClient,
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
