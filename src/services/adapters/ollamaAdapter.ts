import axios, { type AxiosRequestConfig } from 'axios';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

import type { ReasoningEffort } from '@/types/chatConfig';

import { debugLog } from '@/app/lib/debugLogger';
import { MODEL_LIST_TIMEOUT_MS } from '@/constants';
import { getModelContextLimitFromInfo } from '@/services/llmContextLimit';

import type {
  AxiosLike,
  ChatApiResponse,
  ChatMessage,
  ChatParams,
  LlmAdapter,
  LlmModel,
  LlmModelInfo,
  LlmRequestContext,
  LlmTurnStats,
  StreamChatParams,
} from './llmAdapter';

interface TagsResponse {
  models: LlmModel[];
}

/**
 * Ollama's `/api/ps` response. Each loaded model reports the runtime
 * context length that Ollama has actually allocated to the runner.
 * The latter may differ from the modelfile's declared `num_ctx` if
 * the user started the runner with a custom value (e.g.
 * `ollama run --num-ctx 8192 llama3`).
 */
interface PsResponse {
  models: Array<{
    name: string;
    context_length?: number;
  }>;
}

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
 * Map the canonical reasoning effort to Ollama's `think` level field.
 *
 * Ollama's `/api/chat` accepts `think` as a boolean (on/off) OR a level
 * string ('low' | 'medium' | 'high' | 'max'). The canonical set includes
 * values Ollama does not understand, so we translate:
 *   - 'off'/'none'  → false   (explicitly disable thinking)
 *   - 'minimal'/'low' → 'low'
 *   - 'medium'      → 'medium'
 *   - 'high'        → 'high'
 *   - 'xhigh'/'max' → 'max'
 *
 * Note: Ollama's *top-level* `think` field rejects 'max' ("invalid think
 * value: max"), but `options.think` accepts it. Callers therefore put the
 * level in `options.think` and drop the top-level field when a level is
 * present (see `buildChatPayload`).
 */
export function ollamaThinkValue(
  reasoningEffort: ReasoningEffort | undefined,
  think: boolean | undefined
): { level?: 'low' | 'medium' | 'high' | 'max'; toggle?: boolean } {
  if (reasoningEffort !== undefined && reasoningEffort !== 'off') {
    switch (reasoningEffort) {
      case 'none': {
        return { toggle: false };
      }
      case 'minimal':
      case 'low': {
        return { level: 'low' };
      }
      case 'medium': {
        return { level: 'medium' };
      }
      case 'high': {
        return { level: 'high' };
      }
      case 'xhigh':
      case 'max': {
        return { level: 'max' };
      }
    }
  }
  return think === undefined ? {} : { toggle: think };
}

function buildChatPayload(params: ChatParams, stream: boolean) {
  const messages =
    params.visionSupported === false ? stripImagesFromMessages(params.messages) : params.messages;

  const options: Record<string, unknown> = {
    num_ctx: params.numCtx,
    ...params.options,
  };

  // Map the canonical output-token limit to Ollama's native option.
  if (params.maxOutputTokens !== undefined) {
    options.num_predict = params.maxOutputTokens;
  }

  // Resolve thinking control. A reasoning level takes precedence over the
  // boolean toggle; the level is passed via `options.think` (which accepts
  // 'max') rather than the top-level `think` field (which rejects it).
  const { level, toggle } = ollamaThinkValue(params.reasoningEffort, params.think);
  if (level !== undefined) {
    options.think = level;
  }

  const payload: Record<string, unknown> = {
    model: params.model,
    messages,
    tools: params.tools,
    stream,
    options,
  };
  if (level === undefined && toggle !== undefined) {
    payload.think = toggle;
  }

  if (params.format !== undefined) {
    payload.format = params.format;
  }

  return payload;
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

/**
 * Fetch the runtime context length for a model that is currently loaded
 * in the Ollama runner. Returns null if the model is not loaded, the
 * endpoint is unreachable, or the response is missing the field.
 *
 * This value is authoritative when the model is loaded: it reflects what
 * Ollama will actually enforce on the next request, not what the
 * modelfile claims. The model-info path (`/api/show`) returns the
 * modelfile's declared `num_ctx`, which can be overridden at runner
 * start; this function returns the *effective* value.
 */
async function fetchOllamaRunningModelContextLength(
  ctx: LlmRequestContext,
  modelName: string
): Promise<number | null> {
  try {
    const response = await axios.get<PsResponse>(`${ctx.baseUrl}/api/ps`);
    const models = response.data.models || [];
    const model = models.find((m) => m.name === modelName || m.name.startsWith(`${modelName}:`));
    const contextLength = model?.context_length;
    if (typeof contextLength === 'number' && Number.isInteger(contextLength) && contextLength > 0) {
      return contextLength;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchOllamaModels(ctx: LlmRequestContext): Promise<LlmModel[]> {
  const response = await axios.get<TagsResponse>(`${ctx.baseUrl}/api/tags`, {
    timeout: MODEL_LIST_TIMEOUT_MS,
  });
  return response.data.models || [];
}

async function fetchOllamaModelInfo(
  ctx: LlmRequestContext,
  modelName: string,
  _preFetchedModels?: LlmModel[]
): Promise<LlmModelInfo> {
  // Ollama exposes a per-model /api/show endpoint, so we ignore the
  // pre-fetched list and always hit the upstream directly. The optional
  // argument exists only to satisfy the shared LlmAdapter interface.
  const response = await axios.post<LlmModelInfo>(
    `${ctx.baseUrl}/api/show`,
    { name: modelName },
    { timeout: MODEL_LIST_TIMEOUT_MS }
  );
  return response.data;
}

async function sendOllamaChat(
  ctx: LlmRequestContext,
  params: ChatParams,
  onChunk?: (chunk: ChatApiResponse) => void,
  timeoutMs?: number | undefined,
  signal?: AbortSignal
): Promise<ChatApiResponse> {
  const config: AxiosRequestConfig = {};
  if (timeoutMs !== undefined) config.timeout = timeoutMs;
  if (signal) config.signal = signal;

  if (onChunk) {
    const streamParams: StreamChatParams = { ...params, ...(signal ? { signal } : {}) };
    if (timeoutMs !== undefined) streamParams.timeoutMs = timeoutMs;
    const fullMessage: ChatMessage = { role: 'assistant', content: '' };
    let lastChunk: ChatApiResponse | null = null;

    for await (const chunk of sendOllamaChatStream(ctx, streamParams)) {
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
    `${ctx.baseUrl}/api/chat`,
    buildChatPayload(params, false),
    config
  );

  return response.data;
}

async function* sendOllamaChatStream(
  ctx: LlmRequestContext,
  params: StreamChatParams
): AsyncGenerator<ChatApiResponse> {
  const requestConfig: AxiosRequestConfig = {
    responseType: 'stream',
  };
  if (params.signal) {
    requestConfig.signal = params.signal;
  }
  if (params.timeoutMs !== undefined) {
    requestConfig.timeout = params.timeoutMs;
  }

  const response = await axios.post<NodeJS.ReadableStream>(
    `${ctx.baseUrl}/api/chat`,
    buildChatPayload(params, true),
    requestConfig
  );

  const lineReader = createInterface({
    input: response.data as NodeJS.ReadableStream,
    crlfDelay: Infinity,
  });

  const streamStartedAt = Date.now();
  let lineCount = 0;
  let lastLineAt = streamStartedAt;
  let sawFirstLine = false;
  debugLog.diagnostic({
    layer: 'adapter',
    phase: 'model_request_start',
    requestId: ctx.requestId,
    provider: ctx.provider,
    model: params.model,
    baseUrl: ctx.baseUrl,
    result: 'stream_opened',
  });

  try {
    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as ChatApiResponse;
        const now = Date.now();
        lineCount += 1;
        lastLineAt = now;
        if (!sawFirstLine) {
          sawFirstLine = true;
          debugLog.diagnostic({
            layer: 'adapter',
            phase: 'model_first_chunk',
            requestId: ctx.requestId,
            provider: ctx.provider,
            model: params.model,
            baseUrl: ctx.baseUrl,
            elapsedMs: now - streamStartedAt,
          });
        }
        yield parsed;
      } catch {
        continue;
      }
    }
  } finally {
    debugLog.diagnostic({
      layer: 'adapter',
      phase: 'model_complete',
      requestId: ctx.requestId,
      provider: ctx.provider,
      model: params.model,
      baseUrl: ctx.baseUrl,
      elapsedMs: Date.now() - streamStartedAt,
      sinceLastChunkMs: Date.now() - lastLineAt,
      chunkCount: lineCount,
      result: sawFirstLine ? 'streamed' : 'no_lines',
    });
    lineReader.close();
  }
}

async function getOllamaApiErrorMessage(error: unknown): Promise<string> {
  if (axios.isAxiosError(error)) {
    if (error.response?.data) {
      const data = error.response.data;

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
  // Ollama does not need a per-request client; the shared `axios` default
  // is fine. Returning it (rather than a new instance) avoids the
  // per-request axios.create() overhead in the common case.
  buildRequestClient: (_ctx: LlmRequestContext): AxiosLike => axios,
  fetchModels: fetchOllamaModels,
  fetchModelInfo: fetchOllamaModelInfo,
  getModelContextLimit: getModelContextLimitFromInfo,
  sendChat: sendOllamaChat,
  sendChatStream: sendOllamaChatStream,
  getApiErrorMessage: getOllamaApiErrorMessage,
  getTurnStats: getOllamaTurnStats,
  fetchRunningModelContextLength: fetchOllamaRunningModelContextLength,
};
