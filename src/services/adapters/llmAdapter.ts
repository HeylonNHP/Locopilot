import type { ToolCallArguments } from '@/tools/tools';
import type { LlmProvider, ReasoningEffort } from '@/types/chatConfig';

/**
 * Per-request LLM context. Threaded through every LLM call so concurrent
 * requests do not clobber each other's provider, baseUrl, apiKey, or `think`
 * flag. Previously these were read from module-level singletons
 * (`activeAdapter` in `services/llm.ts`, the `client` axios instance in the
 * OpenAI-compatible adapter), which meant two simultaneous requests with
 * different providers (or one with `think: true` and one without) would
 * race on the singleton and pick up the wrong values.
 *
 * Adapters receive this object in `sendChat`/`sendChatStream`/`fetchModels`
 * and use it instead of any module state. The `apiKey` is consulted by both
 * the OpenAI-compatible adapter (always) and the Ollama adapter (only when
 * present — it is used as a Bearer token in the Authorization header).
 */
export interface LlmRequestContext {
  provider?: LlmProvider;
  baseUrl: string;
  apiKey?: string;
  /**
   * Per-request correlation ID stamped by the chat route so adapter-level
   * logs and dump files can be matched to the route's `logger.error` line
   * and the SSE `error` event. Optional — adapters that surface logs
   * (notably the OpenAI-compatible 400 dump) should include it whenever
   * the source request has one.
   */
  requestId?: string;
}

/**
 * Minimal shape of the axios-like HTTP client the LLM adapters use. The
 * real `AxiosInstance` from `axios` satisfies this structurally; declaring
 * the narrow type here keeps the adapter contract free of a hard axios
 * dependency in the interface.
 */
export interface AxiosLike {
  get<T = unknown>(url: string, config?: unknown): Promise<{ data: T }>;
  post<T = unknown>(url: string, data?: unknown, config?: unknown): Promise<{ data: T }>;
  isAxiosError?(error: unknown): boolean;
}

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
  /**
   * Optional stable database id. Populated when a message is loaded from
   * SQLite so callers can reference a specific persisted row (e.g. for
   * deletion). Not sent to the LLM and stripped during serialization.
   */
  id?: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: [ToolCall, ...ToolCall[]];
  /** OpenAI-compatible: identifies which tool call this result answers. */
  tool_call_id?: string;
  /** Base64-encoded images for multimodal/vision models. */
  images?: string[];
  /**
   * ISO-8601 timestamp captured at the moment the user pressed Enter.
   * Persisted in the messages table for every user-role row. Used by the
   * chat route to optionally inject a `[Sent …]` header into the LLM-bound
   * copy of the message; the field itself is stripped before the LLM call.
   */
  createdAt?: string;
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

export interface SubagentLogMessage {
  /** Optional stable database id. See ChatMessage.id for details. */
  id?: number;
  role: 'subagent_log';
  content: string;
  subagentId?: string;
}

export type PersistedChatMessage = ChatMessage | SubagentLogMessage;

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  numCtx: number;
  /**
   * Boolean think flag — passed verbatim to Ollama's `think` field.
   * Coexists with `reasoningEffort` (for OpenAI-compatible providers);
   * each adapter consumes whichever it understands.
   */
  think?: boolean;
  /**
   * Canonical reasoning effort for OpenAI-compatible providers. Maps
   * to the wire `reasoning_effort` field:
   *   - 'off'    → 'none'   (explicit off; required for models with
   *                        reasoning forced on by the provider)
   *   - 'none'   → 'none'
   *   - 'minimal'→ 'minimal'
   *   - 'low'    → 'low'
   *   - 'medium' → 'medium'
   *   - 'high'   → 'high'
   *   - 'xhigh'  → 'xhigh'
   *   - 'max'    → 'max'
   *
   * When set, the OpenAI-compatible adapter emits the corresponding
   * value regardless of whether `tools` is present. Coexists with
   * `think`. The Ollama adapter also consumes it, mapping it to
   * Ollama's `think` level field (see `ollamaThinkValue`).
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * When false, omit image attachments from the outgoing prompt payload.
   * Undefined means unknown and preserves any existing image data.
   */
  visionSupported?: boolean;
  /**
   * Per-parameter sampling support verdicts for the active model,
   * pre-resolved by the chat route via `resolveSamplingParamSupportMap`
   * (see `src/services/samplingParamsCache.ts`). The openai-compatible
   * adapter consults this map before materializing each field in
   * `options` (e.g. `temperature`, `top_p`) onto the outgoing payload.
   * Undefined means every param is treated as supported — the adapter's
   * optimistic default for both openai-compatible and Ollama providers.
   */
  samplingParamSupport?: Record<string, { state: 'supported' | 'unsupported'; source: string }>;
  /**
   * Canonical maximum number of tokens the model may generate.
   * Each adapter maps this to its provider-specific field:
   *   - Ollama          → options.num_predict
   *   - OpenAI-compatible → max_completion_tokens
   *
   * Prefer this over setting `options.num_predict` / `options.max_tokens`
   * directly; the adapter guarantees correct translation.
   */
  maxOutputTokens?: number;
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
  /** Human-readable label to show in the UI (e.g. OpenRouter's `name`). */
  displayName?: string;
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
  readonly id: LlmProvider;
  /**
   * Build the adapter-scoped axios client for this request. Adapters that
   * need per-request headers (e.g. OpenAI-compatible Authorization) create
   * a fresh client here so concurrent requests cannot leak each other's
   * credentials. Adapters that don't need per-request state may return the
   * shared `axios` default.
   */
  buildRequestClient(ctx: LlmRequestContext): AxiosLike;
  fetchModels(ctx: LlmRequestContext): Promise<LlmModel[]>;
  /**
   * Fetch metadata for a single model. Adapters that can resolve per-model
   * info directly (e.g. Ollama's `/api/show`) ignore the optional
   * `preFetchedModels` argument. Adapters whose upstream has no per-model
   * endpoint (e.g. OpenAI-compatible) MAY use a pre-fetched list to skip
   * a redundant network round-trip when the caller already has the list.
   */
  fetchModelInfo(
    ctx: LlmRequestContext,
    modelName: string,
    preFetchedModels?: LlmModel[]
  ): Promise<LlmModelInfo>;
  getModelContextLimit(modelInfo: LlmModelInfo): number | null;
  sendChat(
    ctx: LlmRequestContext,
    params: ChatParams,
    onChunk?: (chunk: ChatApiResponse) => void,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<ChatApiResponse>;
  sendChatStream(ctx: LlmRequestContext, params: StreamChatParams): AsyncGenerator<ChatApiResponse>;
  getApiErrorMessage(error: unknown): Promise<string>;
  getTurnStats(response: ChatApiResponse): LlmTurnStats | null;
  /**
   * If implemented, returns the runtime context length that the provider
   * has actually allocated to a currently-loaded runner, or null if the
   * model is not loaded or the value is unavailable. Used to prefer the
   * effective cap over the modelfile's declared value when reconciling
   * the model context limit.
   */
  fetchRunningModelContextLength?(
    ctx: LlmRequestContext,
    modelName: string
  ): Promise<number | null>;
  /**
   * If implemented, returns a map of sampling-parameter name to whether
   * the given model supports it. Implementations consult their upstream's
   * metadata endpoint (e.g. OpenRouter's `/v1/models` endpoint, which
   * returns a `supported_parameters` list per model). Adapters whose
   * upstream does not surface per-parameter capability (e.g. Ollama)
   * should NOT implement this method and let the cache layer fall back
   * to the provider default of `'supported'` for every param.
   *
   * The chat route calls this once per turn and feeds the result into
   * `resolveSamplingParamSupportMap` (see `src/services/samplingParamsCache.ts`)
   * so the adapter's request builder can consult the cache synchronously.
   */
  fetchSamplingParamSupport?(
    ctx: LlmRequestContext,
    modelName: string
  ): Promise<Partial<Record<string, boolean>> | undefined>;
}
