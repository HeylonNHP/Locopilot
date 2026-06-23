import axios, { type AxiosRequestConfig } from 'axios';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

import type {
  ChatApiResponse,
  ChatMessage,
  ChatParams,
  LlmAdapter,
  LlmModel,
  LlmModelInfo,
  LlmTurnStats,
  StreamChatParams,
} from './llmAdapter';

interface TagsResponse {
  models: LlmModel[];
}

interface PsResponse {
  models: Array<{
    name: string;
    size_vram?: number;
  }>;
}

const CONTEXT_LIMIT_KEY_PATTERN =
  /(?:^|[._])(?:context_length|num_ctx|context_window|max_position_embeddings|max_sequence_length)$/i;

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function findContextLimitInObject(value: unknown): number | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (CONTEXT_LIMIT_KEY_PATTERN.test(key)) {
      const parsed = parsePositiveInteger(nestedValue);
      if (parsed !== null) {
        return parsed;
      }
    }

    const nestedLimit = findContextLimitInObject(nestedValue);
    if (nestedLimit !== null) {
      return nestedLimit;
    }
  }

  return null;
}

function parseContextLimitFromText(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const patterns = [/\bnum_ctx\s+(\d+)\b/i, /\bcontext_length\s+(\d+)\b/i];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function getOllamaModelContextLimit(info: LlmModelInfo): number | null {
  const structuredLimit = findContextLimitInObject(info);
  if (structuredLimit !== null) {
    return structuredLimit;
  }

  for (const text of [info.parameters, info.modelfile]) {
    const parsed = parseContextLimitFromText(text);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
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

  const payload: Record<string, unknown> = {
    model: params.model,
    messages,
    tools: params.tools,
    stream,
    think: params.think,
    options,
  };

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

async function fetchOllamaRunningModelVram(
  baseUrl: string,
  modelName: string
): Promise<number | null> {
  try {
    const response = await axios.get<PsResponse>(`${baseUrl}/api/ps`);
    const models = response.data.models || [];
    const model = models.find((m) => m.name === modelName || m.name.startsWith(`${modelName  }:`));
    if (model && typeof model.size_vram === 'number' && model.size_vram > 0) {
      return model.size_vram;
    }
    return null;
  } catch {
    return null;
  }
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
    `${baseUrl}/api/chat`,
    buildChatPayload(params, true),
    requestConfig
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
  validateConnection: validateOllamaConnection,
  fetchModels: fetchOllamaModels,
  fetchModelInfo: fetchOllamaModelInfo,
  getModelContextLimit: getOllamaModelContextLimit,
  sendChat: sendOllamaChat,
  sendChatStream: sendOllamaChatStream,
  getApiErrorMessage: getOllamaApiErrorMessage,
  getTurnStats: getOllamaTurnStats,
  fetchRunningModelVram: fetchOllamaRunningModelVram,
};
